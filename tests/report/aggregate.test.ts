import { describe, it, expect } from "vitest";
import { buildReport, compressPoints } from "../../src/report/aggregate.js";
import type { QuotaSnapshot } from "../../src/types.js";

const T0 = Date.parse("2026-08-01T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function cc(offsetMs: number, pct: number, resetsAt?: string): QuotaSnapshot {
  return {
    source: "claude-code",
    collectedAt: at(offsetMs),
    session: { used: pct, limit: 100, pct, resetsAt },
  };
}

function report(snaps: QuotaSnapshot[], maxPoints = 600) {
  return buildReport(snaps, {
    since: new Date(T0 - HOUR),
    until: new Date(T0 + 400 * HOUR),
    days: 30,
    maxPoints,
    generatedAt: new Date(T0),
  });
}

describe("buildReport", () => {
  it("returns an empty report for no input", () => {
    const r = report([]);
    expect(r.sources).toEqual([]);
    expect(r.totalEvents).toBe(0);
  });

  it("splits session and weekly into separate series", () => {
    const r = report([
      {
        source: "claude-code",
        collectedAt: at(0),
        session: { used: 10, limit: 100, pct: 10 },
        weekly: { used: 30, limit: 100, pct: 30 },
      },
    ]);
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0].series.map((s) => s.kind)).toEqual([
      "session",
      "weekly",
    ]);
  });

  it("gives each sub-model its own series keyed by name", () => {
    const r = report([
      {
        source: "gemini-cli",
        collectedAt: at(0),
        subModels: [
          { name: "Gemini 3 Pro", used: 5, limit: 100, pct: 5 },
          { name: "Gemini 3 Flash", used: 1, limit: 100, pct: 1 },
        ],
      },
      {
        source: "gemini-cli",
        collectedAt: at(5 * MIN),
        subModels: [{ name: "Gemini 3 Pro", used: 9, limit: 100, pct: 9 }],
      },
    ]);
    const series = r.sources[0].series;
    expect(series.map((s) => s.label)).toEqual([
      "Gemini 3 Flash",
      "Gemini 3 Pro",
    ]);
    expect(series.find((s) => s.label === "Gemini 3 Pro")!.points).toHaveLength(2);
  });

  it("computes remaining from limit and used", () => {
    const r = report([cc(0, 42)]);
    expect(r.sources[0].series[0].points[0].remaining).toBe(58);
  });

  it("keeps error snapshots out of the curve and reports them as outages", () => {
    const r = report([
      cc(0, 10),
      { source: "claude-code", collectedAt: at(5 * MIN), error: "429" },
      { source: "claude-code", collectedAt: at(10 * MIN), error: "429" },
      cc(15 * MIN, 12),
    ]);
    expect(r.sources[0].series[0].points).toHaveLength(2);
    expect(r.sources[0].outages).toHaveLength(1);
    expect(r.sources[0].outages[0]).toMatchObject({
      error: "429",
      count: 2,
      from: T0 + 5 * MIN,
      to: T0 + 10 * MIN,
    });
  });

  it("orders sources alphabetically and series session-then-weekly-then-submodels", () => {
    const r = report([
      { source: "gemini-cli", collectedAt: at(0), subModels: [{ name: "Z", used: 1, limit: 100, pct: 1 }] },
      {
        source: "antigravity",
        collectedAt: at(0),
        weekly: { used: 2, limit: 100, pct: 2 },
        subModels: [{ name: "A", used: 3, limit: 100, pct: 3 }],
      },
    ]);
    expect(r.sources.map((s) => s.source)).toEqual([
      "antigravity",
      "gemini-cli",
    ]);
    expect(r.sources[0].series.map((s) => s.kind)).toEqual([
      "weekly",
      "submodel",
    ]);
  });
});

describe("cycle detection", () => {
  it("starts a new cycle when usage drops", () => {
    const r = report([cc(0, 10), cc(HOUR, 80), cc(2 * HOUR, 3)]);
    const cycles = r.sources[0].series[0].cycles;
    expect(cycles).toHaveLength(2);
    expect(cycles[0].peakPct).toBe(80);
    expect(cycles[1].points).toHaveLength(1);
  });

  it("starts a new cycle when time passes the announced reset, even at flat usage", () => {
    const reset = at(90 * MIN);
    const r = report([
      cc(0, 0, reset),
      cc(HOUR, 0, reset),
      cc(2 * HOUR, 0, at(3 * HOUR)),
    ]);
    expect(r.sources[0].series[0].cycles).toHaveLength(2);
  });

  it("does not split when a rolling reset time drifts forward but usage keeps rising", () => {
    // gemini-style rolling window: resetsAt moves with every poll. Splitting on
    // resetsAt inequality would manufacture a cycle per refresh.
    const r = report([
      cc(0, 10, at(24 * HOUR)),
      cc(HOUR, 20, at(25 * HOUR)),
      cc(2 * HOUR, 30, at(26 * HOUR)),
    ]);
    expect(r.sources[0].series[0].cycles).toHaveLength(1);
  });

  it("tolerates a missing reset time and still splits on the drop", () => {
    const r = report([cc(0, 50), cc(HOUR, 60), cc(2 * HOUR, 1)]);
    expect(r.sources[0].series[0].cycles).toHaveLength(2);
  });

  it("summarises each cycle with peak, final usage and remaining", () => {
    const r = report([cc(0, 10), cc(HOUR, 93), cc(2 * HOUR, 88), cc(3 * HOUR, 5)]);
    const [first] = r.sources[0].series[0].cycles;
    expect(first.peakPct).toBe(93);
    expect(first.finalUsed).toBe(88);
    expect(first.finalRemaining).toBe(12);
    expect(first.startsAt).toBe(T0);
    expect(first.endsAt).toBe(T0 + 2 * HOUR);
  });

  it("exposes the most recent point of each series", () => {
    const r = report([cc(0, 10), cc(HOUR, 77)]);
    expect(r.sources[0].series[0].latest?.pct).toBe(77);
  });
});

describe("compressPoints", () => {
  const pt = (t: number, pct: number) => ({
    t,
    used: pct,
    limit: 100,
    pct,
    remaining: 100 - pct,
    resetsAt: undefined,
  });

  it("collapses a flat run to its two endpoints", () => {
    const out = compressPoints([pt(1, 5), pt(2, 5), pt(3, 5), pt(4, 5)], 600);
    expect(out.map((p) => p.t)).toEqual([1, 4]);
  });

  it("keeps every change point and the step before it", () => {
    const out = compressPoints(
      [pt(1, 5), pt(2, 5), pt(3, 5), pt(4, 9), pt(5, 9)],
      600,
    );
    expect(out.map((p) => p.t)).toEqual([1, 3, 4, 5]);
  });

  it("keeps a lone spike", () => {
    const out = compressPoints([pt(1, 0), pt(2, 50), pt(3, 0)], 600);
    expect(out.map((p) => p.pct)).toEqual([0, 50, 0]);
  });

  it("caps the point count and preserves the peak", () => {
    const dense = Array.from({ length: 5000 }, (_, i) =>
      pt(i, i === 3210 ? 99 : i % 40),
    );
    const out = compressPoints(dense, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(Math.max(...out.map((p) => p.pct))).toBe(99);
    expect(out[0].t).toBe(0);
    expect(out[out.length - 1].t).toBe(4999);
  });

  it("passes short series through untouched", () => {
    const pts = [pt(1, 1), pt(2, 2), pt(3, 3)];
    expect(compressPoints(pts, 600)).toEqual(pts);
  });

  it("handles empty input", () => {
    expect(compressPoints([], 600)).toEqual([]);
  });
});
