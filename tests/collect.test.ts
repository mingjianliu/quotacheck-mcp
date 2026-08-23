import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCollectors, MAX_STALE_FALLBACK_MS } from "../src/collect.js";
import { readHistory } from "../src/history.js";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
} from "../src/types.js";

const ctx: CollectorContext = {
  chromeProfilePath: "/tmp/profile",
  playwrightTimeoutMs: 1000,
  homeDir: "/tmp",
};

// Isolated cache dir so cache-persistence assertions don't fight other tests.
function freshCtx(): CollectorContext {
  return { ...ctx, homeDir: mkdtempSync(join(tmpdir(), "qc-")) };
}

function fake(
  source: QuotaSnapshot["source"],
  result: Partial<QuotaSnapshot>,
): Collector {
  return {
    source,
    collect: async () => ({
      source,
      collectedAt: new Date().toISOString(),
      ...result,
    }),
  };
}

function failing(source: QuotaSnapshot["source"]): Collector {
  return {
    source,
    collect: async () => {
      throw new Error("boom");
    },
  };
}

describe("runCollectors", () => {
  it("runs all collectors in parallel and returns their snapshots", async () => {
    const collectors = [
      fake("claude-code", { session: { used: 1, limit: 10, pct: 10 } }),
      fake("gemini-web", {}),
    ];
    const out = await runCollectors(collectors, ctx, { forceRefresh: true });
    expect(out.map((s) => s.source).sort()).toEqual([
      "claude-code",
      "gemini-web",
    ]);
    expect(out.find((s) => s.source === "claude-code")?.session?.pct).toBe(10);
  });

  it("isolates errors — one failure does not block other sources", async () => {
    // Needs a cache with no prior good gemini-web snapshot, or the last-good
    // substitution below would hand back a success instead of the error.
    const collectors = [failing("gemini-web"), fake("antigravity", {})];
    const out = await runCollectors(collectors, freshCtx(), { forceRefresh: true });
    const web = out.find((s) => s.source === "gemini-web");
    const ag = out.find((s) => s.source === "antigravity");
    expect(web?.error).toBe("boom");
    expect(ag?.error).toBeUndefined();
  });

  it("serves the last-good cached snapshot when a refresh returns an error", async () => {
    const c = freshCtx();
    // First run succeeds and populates the cache.
    await runCollectors(
      [fake("claude-code", { session: { used: 42, limit: 100, pct: 42 } })],
      c,
      { forceRefresh: true },
    );
    // Now the source errors (e.g. rate-limited). We should keep showing the
    // last-known-good data instead of replacing it with an error.
    const out = await runCollectors([failing("claude-code")], c, {
      forceRefresh: true,
    });
    const snap = out.find((s) => s.source === "claude-code");
    expect(snap?.error).toBeUndefined();
    expect(snap?.session?.pct).toBe(42);
  });

  it("stops serving a last-good snapshot once it is older than the fallback window", async () => {
    expect(typeof MAX_STALE_FALLBACK_MS).toBe("number");
    const c = freshCtx();
    // A snapshot old enough that presenting it as current would be a lie.
    const old: Collector = {
      source: "claude-code",
      collect: async () => ({
        source: "claude-code",
        collectedAt: new Date(Date.now() - MAX_STALE_FALLBACK_MS - 60_000).toISOString(),
        session: { used: 42, limit: 100, pct: 42 },
      }),
    };
    await runCollectors([old], c, { forceRefresh: true });
    const out = await runCollectors([failing("claude-code")], c, {
      forceRefresh: true,
    });
    expect(out[0].error).toBe("boom");
    expect(out[0].session).toBeUndefined();
  });

  it("keeps riding out failures while the last-good snapshot is still recent", async () => {
    const c = freshCtx();
    await runCollectors(
      [fake("claude-code", { session: { used: 42, limit: 100, pct: 42 } })],
      c,
      { forceRefresh: true },
    );
    // Repeated failures must not refresh the snapshot's apparent age.
    for (let i = 0; i < 3; i++) {
      await runCollectors([failing("claude-code")], c, { forceRefresh: true });
    }
    const out = await runCollectors([failing("claude-code")], c, {
      forceRefresh: true,
    });
    expect(out[0].session?.pct).toBe(42);
  });

  it("surfaces the error when there is no prior good snapshot to fall back to", async () => {
    const c = freshCtx();
    const out = await runCollectors([failing("claude-code")], c, {
      forceRefresh: true,
    });
    expect(out.find((s) => s.source === "claude-code")?.error).toBe("boom");
  });

  it("records every real collection to history", async () => {
    const c = freshCtx();
    await runCollectors(
      [fake("claude-code", { session: { used: 7, limit: 100, pct: 7 } })],
      c,
      { forceRefresh: true },
    );
    const hist = readHistory(c.homeDir, { since: new Date(Date.now() - 60_000) });
    expect(hist).toHaveLength(1);
    expect(hist[0].session?.pct).toBe(7);
  });

  it("records the real failure, not the last-good snapshot served in its place", async () => {
    const c = freshCtx();
    await runCollectors(
      [fake("claude-code", { session: { used: 42, limit: 100, pct: 42 } })],
      c,
      { forceRefresh: true },
    );
    const out = await runCollectors([failing("claude-code")], c, {
      forceRefresh: true,
    });
    // The caller still sees the last-good snapshot...
    expect(out[0].session?.pct).toBe(42);
    // ...but history must record what actually happened, or the report would
    // show a flat line through an outage as if the quota were really unchanged.
    const hist = readHistory(c.homeDir, { since: new Date(Date.now() - 60_000) });
    expect(hist).toHaveLength(2);
    expect(hist[1].error).toBe("boom");
    expect(hist[1].session).toBeUndefined();
  });

  it("does not record cache hits", async () => {
    const c = freshCtx();
    await runCollectors([fake("claude-code", {})], c, { forceRefresh: true });
    await runCollectors([fake("claude-code", {})], c); // served from cache
    const hist = readHistory(c.homeDir, { since: new Date(Date.now() - 60_000) });
    expect(hist).toHaveLength(1);
  });

  it("skips history entirely when disabled", async () => {
    const c = { ...freshCtx(), historyEnabled: false };
    await runCollectors([fake("claude-code", {})], c, { forceRefresh: true });
    expect(readHistory(c.homeDir, { since: new Date(0) })).toEqual([]);
  });

  it("filters to requested subset when provided", async () => {
    const collectors = [
      fake("claude-code", {}),
      fake("gemini-web", {}),
      fake("antigravity", {}),
    ];
    const out = await runCollectors(collectors, ctx, {
      sources: ["claude-code"],
      forceRefresh: true,
    });
    expect(out.map((s) => s.source)).toEqual(["claude-code"]);
  });

  it("returns snapshots in a fixed alphabetical order by source", async () => {
    const collectors = [
      fake("gemini-web", {}),
      fake("claude-code", {}),
      fake("antigravity", {}),
    ];
    const out = await runCollectors(collectors, ctx, { forceRefresh: true });
    expect(out.map((s) => s.source)).toEqual([
      "antigravity",
      "claude-code",
      "gemini-web",
    ]);
  });
});
