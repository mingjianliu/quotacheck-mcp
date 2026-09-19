import type { QuotaSnapshot, SourceId } from "../types.js";
import { buildReport, type Series, type SeriesPoint } from "./aggregate.js";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const HALF_HOUR_MS = 30 * MIN_MS;

/** Columns in the weekly-level strip; a 7-day window makes each one 3 hours. */
export const STRIP_COLUMNS = 56;

/** A day is a peak when it reaches this share of the busiest day... */
const PEAK_SHARE = 0.6;
/** ...and spent at least this much, so a quiet week has no peaks at all. */
const PEAK_MIN_PCT = 3;

/** Weekly `resetsAt` jitters by milliseconds between polls; a real reset moves it days. */
const WEEKLY_TOLERANCE_MS = HOUR_MS;
const SESSION_TOLERANCE_MS = 30 * MIN_MS;

export interface SessionUsage {
  /** First reading with session usage, clipped to the day row it is listed under. */
  from: number;
  /** The session's reset, clipped to the day row and the window. */
  to: number;
  /** Share of the *weekly* limit spent in [from, to). */
  consumedPct: number;
  /** Highest reading of the session bucket itself; 100 means it was exhausted. */
  sessionPeakPct: number;
  /** `consumedPct` per half hour from `from`. */
  halfHours: number[];
}

export interface DayUsage {
  from: number;
  to: number;
  consumedPct: number;
  peak: boolean;
  sessions: SessionUsage[];
}

export interface WeeklyCycle {
  /** First reading of the cycle — the observed reset, not the announced one. */
  startedAt: number;
  openedAtPct: number;
  /** Level the cycle ended on. Unset for the cycle still running. */
  closedAtPct?: number;
  consumedPct: number;
  /** One row per local day; the day a reset falls on is split across both cycles. */
  days: DayUsage[];
}

export interface StripCell {
  pct: number;
  reset: boolean;
}

export interface QuotaUsage {
  source: SourceId;
  group?: string;
  name: string;
  usedPct: number;
  remainingPct: number;
  nextResetAt?: number;
  consumedPct: number;
  cycles: WeeklyCycle[];
  strip: StripCell[];
}

export interface UsageHistory {
  since: number;
  until: number;
  utcOffsetMin: number;
  quotas: QuotaUsage[];
}

export interface UsageOptions {
  since: Date;
  until: Date;
  /** Offset of the reader's zone from UTC, in minutes. Defaults to this machine's. */
  utcOffsetMin?: number;
}

interface ResetCycle {
  resetsAt: number;
  start: number;
  peak: number;
  points: SeriesPoint[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Split a bucket's readings into cycles by the reset they announce.
 *
 * `resetsAt` is the cycle's identity, which a drop in `pct` is not: around a
 * reset some sources alternate between the old cycle's reading and the new
 * one's for minutes, and every such flap would otherwise look like a full
 * cycle of consumption. Readings that announce an earlier reset than the
 * current cycle are stale and dropped.
 *
 * An idle bucket can report `resetsAt` as "now + window", rolling forward on
 * every poll. That is one unstarted cycle, not many, so it only becomes a
 * cycle of its own once usage shows up — and with `fromFirstUse` the cycle is
 * taken to start there rather than at the idle lead-in.
 */
function splitByReset(
  points: SeriesPoint[],
  toleranceMs: number,
  fromFirstUse = false,
): ResetCycle[] {
  const out: ResetCycle[] = [];
  let cur: ResetCycle | undefined;
  for (const p of points) {
    const resetsAt = p.resetsAt ? Date.parse(p.resetsAt) : NaN;
    if (Number.isNaN(resetsAt)) continue;
    if (cur && resetsAt < cur.resetsAt - toleranceMs) continue;

    const rollingIdle = cur !== undefined && cur.peak === 0 && p.pct === 0;
    if (!cur || (resetsAt > cur.resetsAt + toleranceMs && !rollingIdle)) {
      cur = { resetsAt, start: p.t, peak: 0, points: [] };
      out.push(cur);
    } else if (resetsAt > cur.resetsAt) {
      cur.resetsAt = resetsAt;
    }
    if (fromFirstUse && cur.peak === 0 && p.pct > 0) cur.start = p.t;
    cur.peak = Math.max(cur.peak, p.pct);
    cur.points.push(p);
  }
  return out;
}

interface Spend {
  t: number;
  pct: number;
}

/**
 * Consumption is growth above the cycle's running maximum, so a reading that
 * flaps between two neighbouring values is counted once, not on every flap.
 */
function spends(cycles: ResetCycle[]): Spend[] {
  const out: Spend[] = [];
  cycles.forEach((c, i) => {
    // The first cycle was already running when the window opened.
    let high = i === 0 ? (c.points[0]?.pct ?? 0) : 0;
    for (const p of c.points) {
      if (p.pct <= high) continue;
      out.push({ t: p.t, pct: p.pct - high });
      high = p.pct;
    }
  });
  return out;
}

function isWeekly(s: Series): boolean {
  return s.kind === "weekly" || /weekly/i.test(s.label);
}

function isSession(s: Series): boolean {
  return s.kind === "session" || /5-hour|session/i.test(s.label);
}

export function buildUsageHistory(
  snapshots: QuotaSnapshot[],
  opts: UsageOptions,
): UsageHistory {
  const since = opts.since.getTime();
  const until = opts.until.getTime();
  const utcOffsetMin = opts.utcOffsetMin ?? -new Date().getTimezoneOffset();
  const offsetMs = utcOffsetMin * MIN_MS;
  const nextMidnight = (t: number) =>
    Math.floor((t + offsetMs) / DAY_MS) * DAY_MS + DAY_MS - offsetMs;

  const report = buildReport(snapshots, {
    since: opts.since,
    until: opts.until,
    days: (until - since) / DAY_MS,
  });

  const quotas: QuotaUsage[] = [];
  for (const src of report.sources) {
    for (const weekly of src.series.filter(isWeekly)) {
      const cycles = splitByReset(weekly.points, WEEKLY_TOLERANCE_MS);
      const latest = cycles[cycles.length - 1]?.points.at(-1);
      if (!latest) continue;

      const spent = spends(cycles);
      const spentIn = (from: number, to: number) =>
        round1(
          spent.reduce((n, s) => (s.t >= from && s.t < to ? n + s.pct : n), 0),
        );

      const sessionSeries = src.series.find(
        (s) => isSession(s) && s.group === weekly.group,
      );
      const sessions = sessionSeries
        ? splitByReset(sessionSeries.points, SESSION_TOLERANCE_MS, true).filter(
            (c) => c.peak > 0,
          )
        : [];

      const sessionsIn = (from: number, to: number): SessionUsage[] =>
        sessions
          .filter((s) => s.start < to && s.resetsAt > from)
          .map((s) => {
            const a = Math.max(s.start, from);
            const b = Math.min(s.resetsAt, to);
            const halfHours: number[] = [];
            for (let t = a; t < b; t += HALF_HOUR_MS) {
              halfHours.push(spentIn(t, Math.min(t + HALF_HOUR_MS, b)));
            }
            return {
              from: a,
              to: b,
              consumedPct: spentIn(a, b),
              sessionPeakPct: s.peak,
              halfHours,
            };
          });

      const weeklyCycles: WeeklyCycle[] = cycles.map((c, i) => {
        const from = i === 0 ? since : c.start;
        const to = cycles[i + 1]?.start ?? until;
        const days: DayUsage[] = [];
        for (let a = from; a < to;) {
          const b = Math.min(nextMidnight(a), to);
          days.push({
            from: a,
            to: b,
            consumedPct: spentIn(a, b),
            peak: false,
            sessions: sessionsIn(a, b),
          });
          a = b;
        }
        return {
          startedAt: c.start,
          openedAtPct: i === 0 ? (c.points[0]?.pct ?? 0) : 0,
          closedAtPct: i < cycles.length - 1 ? c.peak : undefined,
          consumedPct: spentIn(from, to),
          days,
        };
      });

      const allDays = weeklyCycles.flatMap((c) => c.days);
      const busiest = Math.max(0, ...allDays.map((d) => d.consumedPct));
      for (const d of allDays) {
        d.peak =
          d.consumedPct >= PEAK_MIN_PCT &&
          d.consumedPct >= PEAK_SHARE * busiest;
      }

      quotas.push({
        source: src.source,
        group: weekly.group,
        name: weekly.group ? `${src.source} · ${weekly.group}` : src.source,
        usedPct: latest.pct,
        remainingPct: round1(100 - latest.pct),
        nextResetAt: cycles[cycles.length - 1].resetsAt,
        consumedPct: spentIn(since, until + 1),
        cycles: weeklyCycles,
        strip: buildStrip(cycles, since, until),
      });
    }
  }

  quotas.sort((a, b) => a.name.localeCompare(b.name));
  return { since, until, utcOffsetMin, quotas };
}

/** The weekly level sampled per column, carrying the last reading across gaps. */
function buildStrip(
  cycles: ResetCycle[],
  since: number,
  until: number,
): StripCell[] {
  const width = (until - since) / STRIP_COLUMNS;
  const points = cycles.flatMap((c) => c.points);
  const resets = cycles.slice(1).map((c) => c.start);
  const strip: StripCell[] = [];
  let level = points[0]?.pct ?? 0;
  let k = 0;
  for (let i = 0; i < STRIP_COLUMNS; i++) {
    const from = since + i * width;
    const to = from + width;
    while (k < points.length && points[k].t < to) level = points[k++].pct;
    strip.push({
      pct: level,
      reset: resets.some((t) => t >= from && t < to),
    });
  }
  return strip;
}
