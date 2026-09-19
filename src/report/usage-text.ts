import type {
  DayUsage,
  QuotaUsage,
  SessionUsage,
  UsageHistory,
} from "./usage.js";

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;
const BLOCKS = "▁▂▃▄▅▆▇█";
const BAR_WIDTH = 22;
/** A full bar stands for at least this much, so a barely-used quota draws short bars. */
const BAR_SCALE_FLOOR_PCT = 10;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One block character for `value` on a 0..max scale; `·` for nothing at all. */
function block(value: number, max: number): string {
  if (value <= 0 || max <= 0) return "·";
  const i = Math.ceil((value / max) * BLOCKS.length) - 1;
  return BLOCKS[Math.min(BLOCKS.length - 1, Math.max(0, i))];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Plain-text usage history, built to be read in a chat transcript: no colour,
 * no width beyond ~90 columns, and nothing that needs a monospace-aware
 * renderer beyond block characters.
 */
export function renderUsageText(history: UsageHistory): string {
  if (history.quotas.length === 0) {
    return "No quota history recorded in this window.";
  }

  // Shift into the reader's zone once, then read the parts back as UTC.
  const local = (t: number) => new Date(t + history.utcOffsetMin * MIN_MS);
  const date = (t: number) => {
    const d = local(t);
    return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  };
  const weekday = (t: number) => WEEKDAYS[local(t).getUTCDay()];
  const clock = (t: number) => {
    const d = local(t);
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    return `${h % 12 || 12}${m ? ":" + pad2(m) : ""}${h < 12 ? "AM" : "PM"}`;
  };
  const stamp = (t: number) => `${weekday(t)} ${date(t)} ${clock(t)}`;

  const days = Math.round((history.until - history.since) / DAY_MS);
  const sign = history.utcOffsetMin < 0 ? "-" : "+";
  const off = Math.abs(history.utcOffsetMin);
  const zone = `UTC${sign}${pad2(Math.floor(off / 60))}:${pad2(off % 60)}`;

  const sessionLine = (s: SessionUsage) => {
    const max = Math.max(...s.halfHours);
    const span = `${clock(s.from).padStart(7)}→${clock(s.to).padEnd(7)}`;
    const peak = `${String(Math.round(s.sessionPeakPct)).padStart(3)}%${s.sessionPeakPct >= 100 ? " ⛔" : ""}`;
    return `      ├ session ${span} weekly +${String(Math.round(s.consumedPct)).padStart(2)}% · session peaked ${peak}  ${s.halfHours.map((v) => block(v, max)).join("")}`;
  };

  const dayLines = (d: DayUsage, busiest: number) => {
    const width = busiest > 0 ? Math.round((d.consumedPct / busiest) * BAR_WIDTH) : 0;
    const row = `  ${date(d.from)} ${weekday(d.from)} ${"█".repeat(width).padEnd(BAR_WIDTH)} ${String(Math.round(d.consumedPct)).padStart(3)}%${d.peak ? "  ◀ PEAK" : ""}`;
    if (!d.peak) return [row];
    const sessions = d.sessions.filter((s) => s.consumedPct > 0);
    return [
      row,
      ...(sessions.length > 0
        ? sessions.map(sessionLine)
        : ["      ├ (no session data for this day)"]),
    ];
  };

  const quotaLines = (q: QuotaUsage) => {
    const lines = [
      `━━━━ ${q.name} ━━━━`,
      `now ${Math.round(q.usedPct)}% used · ${Math.round(q.remainingPct)}% left · next weekly reset ${q.nextResetAt ? stamp(q.nextResetAt) : "unknown"} · spent ${Math.round(q.consumedPct)}% of a weekly limit in ${days}d`,
      "",
      `weekly level  ${q.strip.map((c) => (c.reset ? "┃" : block(c.pct, 100))).join("")}`,
    ];

    // Day ticks only line up when a day is a whole number of columns.
    const perDay = q.strip.length / days;
    if (Number.isInteger(perDay)) {
      let ticks = "";
      for (let i = 0; i < days; i++) {
        ticks += String(local(history.since + i * DAY_MS + DAY_MS / 2).getUTCDate()).padEnd(perDay);
      }
      lines.push(`              ${ticks.trimEnd()}`);
    }
    lines.push("");

    const busiest = Math.max(
      BAR_SCALE_FLOOR_PCT,
      ...q.cycles.flatMap((c) => c.days.map((d) => d.consumedPct)),
    );
    q.cycles.forEach((c, i) => {
      const prev = q.cycles[i - 1];
      lines.push(
        prev
          ? `══════ ⟲ WEEKLY RESET ${stamp(c.startedAt)} · previous cycle closed at ${Math.round(prev.closedAtPct ?? 0)}% ══════`
          : `┄┄┄┄┄┄ weekly cycle already at ${Math.round(c.openedAtPct)}% when the window opens ┄┄┄┄┄┄`,
      );
      for (const d of c.days) lines.push(...dayLines(d, busiest));
    });
    return lines;
  };

  return [
    `Quota usage, last ${days} days (times in ${zone}).`,
    "Bars: share of the weekly limit spent that day. ┃ in the level strip: weekly reset.",
    "Peak days expand into sessions; the trailing sparkline is weekly spend per half hour.",
    "",
    ...history.quotas.flatMap((q) => [...quotaLines(q), ""]),
  ]
    .join("\n")
    .trimEnd();
}
