import { describe, it, expect } from "vitest";
import { buildUsageHistory } from "../../src/report/usage.js";
import type { QuotaSnapshot } from "../../src/types.js";

const T0 = Date.parse("2026-08-03T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

/** claude-code reading: weekly pct, plus an optional session bucket. */
function cc(
  offsetMs: number,
  weekly: { pct: number; resetsAt: string },
  session?: { pct: number; resetsAt: string },
): QuotaSnapshot {
  const bucket = (b: { pct: number; resetsAt: string }) => ({
    used: b.pct,
    limit: 100,
    pct: b.pct,
    resetsAt: b.resetsAt,
  });
  return {
    source: "claude-code",
    collectedAt: at(offsetMs),
    weekly: bucket(weekly),
    session: session ? bucket(session) : undefined,
  };
}

function usage(snaps: QuotaSnapshot[], days = 7) {
  return buildUsageHistory(snaps, {
    since: new Date(T0),
    until: new Date(T0 + days * DAY),
    utcOffsetMin: 0,
  });
}

const WEEK1 = at(3 * DAY);
const WEEK2 = at(10 * DAY);

describe("buildUsageHistory", () => {
  it("returns no quotas for no input", () => {
    expect(usage([]).quotas).toEqual([]);
  });

  it("counts growth of the weekly bucket as consumption", () => {
    const u = usage([
      cc(0, { pct: 10, resetsAt: WEEK1 }),
      cc(HOUR, { pct: 14, resetsAt: WEEK1 }),
      cc(2 * HOUR, { pct: 25, resetsAt: WEEK1 }),
    ]);
    expect(u.quotas).toHaveLength(1);
    const q = u.quotas[0];
    expect(q.name).toBe("claude-code");
    expect(q.consumedPct).toBe(15);
    expect(q.usedPct).toBe(25);
    expect(q.remainingPct).toBe(75);
    expect(q.nextResetAt).toBe(Date.parse(WEEK1));
  });

  it("does not double count a reading that flaps between two values", () => {
    const u = usage([
      cc(0, { pct: 50, resetsAt: WEEK1 }),
      cc(1 * MIN, { pct: 51, resetsAt: WEEK1 }),
      cc(2 * MIN, { pct: 50, resetsAt: WEEK1 }),
      cc(3 * MIN, { pct: 51, resetsAt: WEEK1 }),
      cc(4 * MIN, { pct: 50, resetsAt: WEEK1 }),
      cc(5 * MIN, { pct: 51, resetsAt: WEEK1 }),
    ]);
    expect(u.quotas[0].consumedPct).toBe(1);
  });

  it("opens a new weekly cycle when resetsAt moves forward", () => {
    const u = usage([
      cc(0, { pct: 90, resetsAt: WEEK1 }),
      cc(3 * DAY + HOUR, { pct: 0, resetsAt: WEEK2 }),
      cc(3 * DAY + 2 * HOUR, { pct: 7, resetsAt: WEEK2 }),
    ]);
    const cycles = u.quotas[0].cycles;
    expect(cycles).toHaveLength(2);
    expect(cycles[0].openedAtPct).toBe(90);
    expect(cycles[0].closedAtPct).toBe(90);
    expect(cycles[1].startedAt).toBe(T0 + 3 * DAY + HOUR);
    expect(cycles[1].closedAtPct).toBeUndefined();
    expect(u.quotas[0].consumedPct).toBe(7);
  });

  it("ignores stale previous-cycle readings that flap in around a reset", () => {
    const t = 3 * DAY;
    const u = usage([
      cc(0, { pct: 45, resetsAt: WEEK1 }),
      cc(t, { pct: 0, resetsAt: WEEK2 }),
      cc(t + 1 * MIN, { pct: 45, resetsAt: WEEK1 }),
      cc(t + 2 * MIN, { pct: 0, resetsAt: WEEK2 }),
      cc(t + 3 * MIN, { pct: 45, resetsAt: WEEK1 }),
      cc(t + 4 * MIN, { pct: 2, resetsAt: WEEK2 }),
    ]);
    const q = u.quotas[0];
    expect(q.cycles).toHaveLength(2);
    expect(q.consumedPct).toBe(2);
    expect(q.usedPct).toBe(2);
  });

  it("tolerates sub-second jitter in resetsAt without opening cycles", () => {
    const jitter = new Date(Date.parse(WEEK1) + 441).toISOString();
    const u = usage([
      cc(0, { pct: 10, resetsAt: WEEK1 }),
      cc(HOUR, { pct: 12, resetsAt: jitter }),
    ]);
    expect(u.quotas[0].cycles).toHaveLength(1);
  });

  it("splits the day a weekly reset falls on into a row per cycle", () => {
    const reset = 3 * DAY + 10 * HOUR;
    const u = usage([
      cc(3 * DAY, { pct: 80, resetsAt: at(reset) }),
      cc(3 * DAY + 2 * HOUR, { pct: 85, resetsAt: at(reset) }),
      cc(reset, { pct: 0, resetsAt: WEEK2 }),
      cc(reset + HOUR, { pct: 12, resetsAt: WEEK2 }),
    ]);
    const [before, after] = u.quotas[0].cycles;
    const lastBefore = before.days[before.days.length - 1];
    expect(lastBefore.from).toBe(T0 + 3 * DAY);
    expect(lastBefore.to).toBe(T0 + reset);
    expect(lastBefore.consumedPct).toBe(5);
    expect(after.days[0].from).toBe(T0 + reset);
    expect(after.days[0].to).toBe(T0 + 4 * DAY);
    expect(after.days[0].consumedPct).toBe(12);
  });

  it("cuts days at local midnight for the given UTC offset", () => {
    const u = buildUsageHistory([cc(0, { pct: 1, resetsAt: WEEK2 })], {
      since: new Date(T0),
      until: new Date(T0 + 2 * DAY),
      utcOffsetMin: -240,
    });
    const days = u.quotas[0].cycles[0].days;
    expect(days[0].to).toBe(T0 + 4 * HOUR);
    expect(days[1].to).toBe(T0 + 28 * HOUR);
  });

  it("flags days at or above 60% of the busiest day as peaks", () => {
    const u = usage([
      cc(0, { pct: 0, resetsAt: WEEK2 }),
      cc(HOUR, { pct: 30, resetsAt: WEEK2 }),
      cc(DAY + HOUR, { pct: 50, resetsAt: WEEK2 }),
      cc(2 * DAY + HOUR, { pct: 55, resetsAt: WEEK2 }),
    ]);
    const days = u.quotas[0].cycles[0].days;
    expect(days.slice(0, 3).map((d) => d.consumedPct)).toEqual([30, 20, 5]);
    expect(days.slice(0, 3).map((d) => d.peak)).toEqual([true, true, false]);
  });

  it("never flags a peak when usage is negligible", () => {
    const u = usage([
      cc(0, { pct: 0, resetsAt: WEEK2 }),
      cc(HOUR, { pct: 1, resetsAt: WEEK2 }),
    ]);
    expect(u.quotas[0].cycles[0].days.some((d) => d.peak)).toBe(false);
  });

  it("attributes weekly consumption to the session it happened in", () => {
    const s1 = at(5 * HOUR);
    const s2 = at(11 * HOUR);
    const u = usage([
      cc(0, { pct: 0, resetsAt: WEEK2 }, { pct: 0, resetsAt: s1 }),
      cc(1 * HOUR, { pct: 4, resetsAt: WEEK2 }, { pct: 30, resetsAt: s1 }),
      cc(2 * HOUR, { pct: 10, resetsAt: WEEK2 }, { pct: 80, resetsAt: s1 }),
      cc(6 * HOUR, { pct: 10, resetsAt: WEEK2 }, { pct: 0, resetsAt: s2 }),
      cc(7 * HOUR, { pct: 13, resetsAt: WEEK2 }, { pct: 100, resetsAt: s2 }),
    ]);
    const sessions = u.quotas[0].cycles[0].days[0].sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      from: T0 + HOUR,
      to: T0 + 5 * HOUR,
      consumedPct: 10,
      sessionPeakPct: 80,
    });
    expect(sessions[1]).toMatchObject({
      from: T0 + 7 * HOUR,
      to: T0 + 11 * HOUR,
      consumedPct: 3,
      sessionPeakPct: 100,
    });
  });

  it("buckets a session's consumption into half hours", () => {
    const s1 = at(5 * HOUR);
    const u = usage([
      cc(0, { pct: 0, resetsAt: WEEK2 }, { pct: 1, resetsAt: s1 }),
      cc(10 * MIN, { pct: 2, resetsAt: WEEK2 }, { pct: 10, resetsAt: s1 }),
      cc(70 * MIN, { pct: 8, resetsAt: WEEK2 }, { pct: 40, resetsAt: s1 }),
    ]);
    const s = u.quotas[0].cycles[0].days[0].sessions[0];
    expect(s.halfHours).toHaveLength(10);
    expect(s.halfHours.slice(0, 3)).toEqual([2, 0, 6]);
  });

  it("does not turn an idle session whose resetsAt rolls forward into sessions", () => {
    const snaps: QuotaSnapshot[] = [];
    for (let h = 0; h < 12; h++) {
      snaps.push(
        cc(
          h * HOUR,
          { pct: 5, resetsAt: WEEK2 },
          { pct: 0, resetsAt: at((h + 5) * HOUR) },
        ),
      );
    }
    snaps.push(
      cc(
        12 * HOUR,
        { pct: 9, resetsAt: WEEK2 },
        { pct: 20, resetsAt: at(17 * HOUR) },
      ),
    );
    const sessions = usage(snaps).quotas[0].cycles[0].days[0].sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].from).toBe(T0 + 12 * HOUR);
    expect(sessions[0].consumedPct).toBe(4);
  });

  it("pairs a shared-limit group's weekly bucket with its own 5-hour bucket", () => {
    const sm = (
      name: string,
      group: string,
      pct: number,
      resetsAt: string,
    ) => ({
      name,
      group,
      used: pct,
      limit: 100,
      pct,
      resetsAt,
    });
    const snap = (
      off: number,
      gW: number,
      gS: number,
      cW: number,
    ): QuotaSnapshot => ({
      source: "antigravity",
      collectedAt: at(off),
      subModels: [
        sm(
          "Claude and GPT models · Weekly",
          "Claude and GPT models",
          cW,
          WEEK2,
        ),
        sm(
          "Claude and GPT models · 5-hour",
          "Claude and GPT models",
          0,
          at(off + 5 * HOUR),
        ),
        sm("Gemini Models · Weekly", "Gemini Models", gW, WEEK2),
        sm("Gemini Models · 5-hour", "Gemini Models", gS, at(5 * HOUR)),
      ],
    });
    const u = usage([snap(0, 0, 0, 3), snap(HOUR, 6, 40, 3)]);
    expect(u.quotas.map((q) => q.name)).toEqual([
      "antigravity · Claude and GPT models",
      "antigravity · Gemini Models",
    ]);
    expect(u.quotas[0].cycles[0].days[0].sessions).toEqual([]);
    expect(u.quotas[1].cycles[0].days[0].sessions[0]).toMatchObject({
      consumedPct: 6,
      sessionPeakPct: 40,
    });
  });

  it("samples the weekly level into a strip that marks resets", () => {
    const u = usage([
      cc(0, { pct: 96, resetsAt: WEEK1 }),
      cc(3 * DAY + HOUR, { pct: 0, resetsAt: WEEK2 }),
      cc(5 * DAY, { pct: 40, resetsAt: WEEK2 }),
    ]);
    const strip = u.quotas[0].strip;
    expect(strip).toHaveLength(56);
    expect(strip[0]).toEqual({ pct: 96, reset: false });
    expect(strip.filter((c) => c.reset)).toHaveLength(1);
    expect(strip[24].reset).toBe(true);
    expect(strip[55].pct).toBe(40);
  });

  it("skips failed collections", () => {
    const u = usage([
      cc(0, { pct: 10, resetsAt: WEEK1 }),
      { source: "claude-code", collectedAt: at(HOUR), error: "timed out" },
      cc(2 * HOUR, { pct: 12, resetsAt: WEEK1 }),
    ]);
    expect(u.quotas[0].consumedPct).toBe(2);
  });
});
