import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator.js";
import { normalizeSnapshot } from "../src/observation.js";
import { ObservationStore } from "../src/store.js";
import { burnRate, currentCycle, displayLabel, getPanel, tierOf } from "../src/panel.js";
import { codexLimits } from "../src/source-mapping.js";
import type { Collector, QuotaSnapshot } from "../src/types.js";

const HOUR = 3600000;
const NOW = Date.parse("2026-10-21T12:00:00Z");
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true })));

/** Record history and let a coordinator make the last snapshot the current reading. */
async function seed(snaps: QuotaSnapshot[]) {
  const home = mkdtempSync(join(tmpdir(), "qc-panel-"));
  homes.push(home);
  const store = new ObservationStore(home);
  for (const s of snaps.slice(0, -1)) store.append(normalizeSnapshot(s));
  const last = snaps[snaps.length - 1];
  const collector: Collector = { source: last.source, collect: async () => last };
  const c = new Coordinator([collector], { homeDir: home, chromeProfilePath: "", playwrightTimeoutMs: 1 }, store, { now: () => Date.parse(last.collectedAt) });
  c.refresh([last.source]);
  await c.idle();
  return home;
}

const claude = (t: number, session: number, weekly: number, sessionReset = NOW + 2 * HOUR): QuotaSnapshot => ({
  source: "claude-code",
  collectedAt: new Date(t).toISOString(),
  accountKey: "claude:abc",
  limits: [
    { id: "session", label: "Session", scope: {}, window: { kind: "session", resetsAt: new Date(sessionReset).toISOString() }, measurement: { utilizationPct: session }, provenance: { kind: "reported", paths: ["five_hour"], identity: "stable" } },
    { id: "weekly", label: "Weekly", scope: {}, window: { kind: "weekly", resetsAt: new Date(NOW + 72 * HOUR).toISOString() }, measurement: { utilizationPct: weekly }, provenance: { kind: "reported", paths: ["seven_day"], identity: "stable" } },
  ],
  extensions: { account: { type: "claude", planType: "max", label: "s…@example.com · max" } },
});

describe("panel", () => {
  it("works out burn rate, projection and an early warning from history", async () => {
    // Session climbs 20 points an hour: 40% now, out of quota in 3 h, reset in 2 h.
    const home = await seed([claude(NOW - 2 * HOUR, 0, 10), claude(NOW - HOUR, 20, 11), claude(NOW, 40, 12)]);
    const panel = getPanel(home, new Date(NOW), { userHome: home });
    const src = panel.sources.find((s) => s.source === "claude-code")!;
    expect(src.account).toEqual({ label: "s…@example.com · max", plan: "max" });
    const [session, weekly] = src.windows;
    expect(session).toMatchObject({ label: "5-hour", pct: 40, burnPerHour: 20, projectedPct: 80, tier: "ok" });
    expect(session.runsOutAt).toBeUndefined();
    expect(weekly).toMatchObject({ label: "Weekly", pct: 12, burnPerHour: 1, tier: "ok" });
    expect(panel.headline).toMatchObject({ source: "claude-code", label: "5-hour", pct: 40 });
  });

  it("warns before 70% when the pace runs out before the reset", async () => {
    const home = await seed([claude(NOW - HOUR, 30, 5, NOW + 4 * HOUR), claude(NOW, 60, 5, NOW + 4 * HOUR)]);
    const session = getPanel(home, new Date(NOW), { userHome: home }).sources[0].windows[0];
    expect(session).toMatchObject({ pct: 60, burnPerHour: 30, projectedPct: 100, tier: "warn" });
    expect(Date.parse(session.runsOutAt!)).toBe(NOW + (40 / 30) * HOUR);
  });

  it("starts the rate over after a reset", () => {
    const points = [{ t: 0, pct: 80, resetsAt: HOUR }, { t: HOUR + 1, pct: 2 }, { t: 2 * HOUR, pct: 12 }];
    expect(currentCycle(points)).toHaveLength(2);
    expect(burnRate(points, 2 * HOUR)).toBeCloseTo(10, 0);
    // A single reading, or two a minute apart, say nothing about the pace.
    expect(burnRate([{ t: 0, pct: 5 }], 0)).toBeUndefined();
    expect(burnRate([{ t: 0, pct: 5 }, { t: 60000, pct: 6 }], 60000)).toBeUndefined();
  });

  it("colours by Agent HUD's thresholds", () => {
    expect([tierOf(69), tierOf(70), tierOf(89.9), tierOf(90), tierOf(10, true)]).toEqual(["ok", "warn", "warn", "critical", "warn"]);
  });

  it("names windows the way each tool's own UI does", () => {
    const codex = codexLimits({ rateLimits: {}, rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 300 } }, spark: { limitId: "spark", limitName: "Spark", primary: { usedPercent: 1, windowDurationMins: 10080 } } } });
    expect(codex.map((l) => displayLabel("codex", l))).toEqual(["5-hour", "Spark · Weekly"]);
    const opus = { id: "model:opus:weekly", label: "Opus · weekly", scope: {}, window: { kind: "weekly" }, measurement: { utilizationPct: 3 }, provenance: { kind: "reported" as const, paths: [], identity: "stable" as const } };
    expect(displayLabel("claude-code", opus)).toBe("Weekly · Opus");
  });

  it("shows Codex reset credits and keeps the account label", async () => {
    const raw = { rateLimits: { primary: { usedPercent: 49, windowDurationMins: 10080 } }, rateLimitResetCredits: { availableCount: 2, credits: [{ id: "b", expiresAt: 1794000000, grantedAt: 1, resetType: "x", status: "available" }, { id: "a", expiresAt: 1793000000, grantedAt: 1, resetType: "x", status: "available" }] } };
    const home = await seed([{ source: "codex", collectedAt: new Date(NOW).toISOString(), accountKey: "chatgpt:x", limits: codexLimits(raw), extensions: { response: raw, account: { type: "chatgpt", planType: "pro", label: "s…@example.com · pro" } } }]);
    const src = getPanel(home, new Date(NOW), { userHome: home }).sources.find((s) => s.source === "codex")!;
    expect(src.resetCredits).toEqual({ available: 2, firstExpiresAt: new Date(1793000000 * 1000).toISOString() });
    expect(src.windows[0]).toMatchObject({ label: "Weekly", pct: 49 });
    expect(src.windows[0].groupLabel).toBeUndefined();
    expect(src.account?.label).toBe("s…@example.com · pro");
  });

  it("lists enabled sources without data as missing, with their error", async () => {
    const home = await seed([claude(NOW, 1, 1)]);
    const missing = getPanel(home, new Date(NOW), { userHome: home }).sources.find((s) => s.source === "gemini-web")!;
    expect(missing).toMatchObject({ freshness: "missing", windows: [] });
  });
});

describe("grouped windows", () => {
  it("heads each shared-limit group once and names rows by window", async () => {
    const { antigravityLimitsFromRows } = await import("../src/source-mapping.js");
    const limits = antigravityLimitsFromRows([
      { group: "Gemini Models", window: "Weekly Limit Remaining", remaining: 91, period: "weekly" },
      { group: "Claude and GPT models", window: "Weekly Limit Remaining", remaining: 7, period: "weekly" },
      { group: "Gemini Models", window: "Five Hour Limit Remaining", remaining: 69, period: "5h" },
    ]);
    const home = await seed([{ source: "antigravity", collectedAt: new Date(NOW).toISOString(), limits }]);
    const panel = getPanel(home, new Date(NOW), { userHome: home });
    const rows = panel.sources.find((s) => s.source === "antigravity")!.windows.map((w) => [w.groupLabel, w.label, w.tier]);
    expect(rows).toEqual([["Claude and GPT models", "Weekly", "critical"], ["Gemini Models", "5-hour", "ok"], ["Gemini Models", "Weekly", "ok"]]);
    expect(panel.headline).toMatchObject({ label: "Claude and GPT models · Weekly", pct: 93 });
  });
});

describe("token chart", () => {
  it("adds the day's tokens from local agent logs, unless switched off", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const home = await seed([claude(NOW, 1, 1)]);
    const dir = join(home, ".claude", "projects", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.jsonl"), JSON.stringify({ type: "assistant", sessionId: "s", cwd: "/x/proj", timestamp: new Date(NOW - HOUR).toISOString(), message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 7, output_tokens: 3 } } }) + "\n");
    expect(getPanel(home, new Date(NOW), { userHome: home }).tokens?.totals["claude-code"]?.total).toBe(10);
    writeFileSync(join(home, ".config", "quotacheck-mcp", "config.json"), JSON.stringify({ tokenStatsEnabled: false }));
    expect(getPanel(home, new Date(NOW), { userHome: home }).tokens).toBeUndefined();
  });
});
