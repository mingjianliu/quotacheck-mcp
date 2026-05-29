import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCollectors } from "../src/collect.js";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
} from "../src/types.js";

const ctx: CollectorContext = {
  chromeProfilePath: "/tmp/profile",
  playwrightTimeoutMs: 1000,
  antigravityUsageBinary: "antigravity-usage",
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
      fake("gemini-cli", {}),
    ];
    const out = await runCollectors(collectors, ctx, { forceRefresh: true });
    expect(out.map((s) => s.source).sort()).toEqual([
      "claude-code",
      "gemini-cli",
    ]);
    expect(out.find((s) => s.source === "claude-code")?.session?.pct).toBe(10);
  });

  it("isolates errors — one failure does not block other sources", async () => {
    const collectors = [failing("gemini-web"), fake("antigravity", {})];
    const out = await runCollectors(collectors, ctx, { forceRefresh: true });
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

  it("surfaces the error when there is no prior good snapshot to fall back to", async () => {
    const c = freshCtx();
    const out = await runCollectors([failing("claude-code")], c, {
      forceRefresh: true,
    });
    expect(out.find((s) => s.source === "claude-code")?.error).toBe("boom");
  });

  it("filters to requested subset when provided", async () => {
    const collectors = [
      fake("claude-code", {}),
      fake("gemini-cli", {}),
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
      fake("gemini-cli", {}),
      fake("claude-code", {}),
      fake("antigravity", {}),
    ];
    const out = await runCollectors(collectors, ctx, { forceRefresh: true });
    expect(out.map((s) => s.source)).toEqual([
      "antigravity",
      "claude-code",
      "gemini-cli",
    ]);
  });
});
