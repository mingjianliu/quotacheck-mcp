import { describe, it, expect } from "vitest";
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
});
