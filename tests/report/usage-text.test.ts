import { describe, it, expect } from "vitest";
import { buildUsageHistory } from "../../src/report/usage.js";
import { renderUsageText } from "../../src/report/usage-text.js";
import type { QuotaSnapshot } from "../../src/types.js";

const T0 = Date.parse("2026-08-03T00:00:00.000Z"); // a Monday
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (off: number) => new Date(T0 + off).toISOString();

function cc(
  off: number,
  weekly: [number, string],
  session?: [number, string],
): QuotaSnapshot {
  const b = ([pct, resetsAt]: [number, string]) => ({
    used: pct,
    limit: 100,
    pct,
    resetsAt,
  });
  return {
    source: "claude-code",
    collectedAt: at(off),
    weekly: b(weekly),
    session: session ? b(session) : undefined,
  };
}

const W1 = at(2 * DAY + 10 * HOUR);
const W2 = at(9 * DAY + 10 * HOUR);

function text(snaps: QuotaSnapshot[], utcOffsetMin = 0): string {
  return renderUsageText(
    buildUsageHistory(snaps, {
      since: new Date(T0),
      until: new Date(T0 + 7 * DAY),
      utcOffsetMin,
    }),
  );
}

const WEEK = [
  cc(0, [90, W1]),
  cc(DAY, [92, W1]),
  cc(2 * DAY + 10 * HOUR, [0, W2], [0, at(2 * DAY + 16 * HOUR)]),
  cc(2 * DAY + 11 * HOUR, [10, W2], [50, at(2 * DAY + 16 * HOUR)]),
  cc(2 * DAY + 12 * HOUR, [24, W2], [100, at(2 * DAY + 16 * HOUR)]),
  cc(4 * DAY + HOUR, [26, W2], [9, at(4 * DAY + 6 * HOUR)]),
];

describe("renderUsageText", () => {
  it("says so when there is no history", () => {
    expect(text([])).toMatch(/no quota history/i);
  });

  it("heads each quota with what is used, left, and when it resets", () => {
    const out = text(WEEK);
    expect(out).toContain("claude-code");
    expect(out).toContain("26% used · 74% left");
    expect(out).toContain("next weekly reset Wed 08-12 10AM");
  });

  it("draws the weekly level as a strip with a bar at the reset", () => {
    const strip = text(WEEK)
      .split("\n")
      .find((l) => l.startsWith("weekly level"))!;
    expect(strip).toContain(" " + "█".repeat(19) + "┃▂");
  });

  it("separates weekly cycles with a reset divider", () => {
    const lines = text(WEEK).split("\n");
    const divider = lines.findIndex((l) => l.includes("WEEKLY RESET"));
    expect(lines[divider]).toContain("Wed 08-05 10AM");
    expect(lines[divider]).toContain("previous cycle closed at 92%");
    expect(lines[divider - 1]).toMatch(/^ {2}08-05 Wed/);
    expect(lines[divider + 1]).toMatch(/^ {2}08-05 Wed .*24%.*PEAK/);
  });

  it("notes the level the window opened on", () => {
    expect(text(WEEK)).toContain("already at 90% when the window opens");
  });

  it("expands sessions under peak days only", () => {
    const lines = text(WEEK).split("\n");
    const sessions = lines.filter((l) => l.includes("├ session"));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toContain("11AM→4PM");
    expect(sessions[0]).toContain("weekly +24%");
    expect(sessions[0]).toContain("session peaked 100% ⛔");
    expect(sessions[0]).toMatch(/▆·█·{7}$/);
  });

  it("keeps bars short for a quota that was barely used", () => {
    const row = text([cc(0, [0, W2]), cc(HOUR, [1, W2])])
      .split("\n")
      .find((l) => l.startsWith("  08-03 Mon"))!;
    // a full bar stands for at least 10% of the weekly limit
    expect(row.match(/█/g)).toHaveLength(2);
  });

  it("formats times in the reader's zone", () => {
    expect(text(WEEK, -240)).toContain("WEEKLY RESET Wed 08-05 6AM");
  });
});
