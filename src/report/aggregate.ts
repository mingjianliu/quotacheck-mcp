import type { QuotaSnapshot, SourceId, Bucket } from "../types.js";

export interface SeriesPoint {
  t: number;
  used: number;
  limit: number;
  pct: number;
  remaining: number;
  resetsAt?: string;
}

export type SeriesKind = "session" | "weekly" | "submodel";

export interface Cycle {
  startsAt: number;
  endsAt: number;
  /** Reset instant this cycle last announced, if the source reports one. */
  resetsAt?: string;
  peakPct: number;
  peakUsed: number;
  finalUsed: number;
  finalRemaining: number;
  limit: number;
  points: SeriesPoint[];
}

export interface Series {
  key: string;
  source: SourceId;
  kind: SeriesKind;
  label: string;
  limit: number;
  points: SeriesPoint[];
  cycles: Cycle[];
  latest?: SeriesPoint;
}

export interface Outage {
  from: number;
  to: number;
  error: string;
  count: number;
}

export interface SourceReport {
  source: SourceId;
  series: Series[];
  outages: Outage[];
  eventCount: number;
  errorCount: number;
  lastCollectedAt?: number;
}

export interface ReportData {
  generatedAt: string;
  since: number;
  until: number;
  days: number;
  totalEvents: number;
  /** Draw-time point budget the page applies per visible range. */
  maxPoints: number;
  sources: SourceReport[];
}

export interface BuildOptions {
  since: Date;
  until: Date;
  days: number;
  maxPoints?: number;
  generatedAt?: Date;
}

export const DEFAULT_MAX_POINTS = 600;

/** Absolute floor on what counts as a reset, so noise near zero is ignored. */
const MIN_RESET_DROP = 20;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toPoint(t: number, b: Bucket): SeriesPoint {
  return {
    t,
    used: b.used,
    limit: b.limit,
    pct: b.pct,
    remaining: round2(b.limit - b.used),
    resetsAt: b.resetsAt,
  };
}

/** Identity of a sample for run-length collapsing. */
function valueKey(p: SeriesPoint): string {
  return `${p.used}|${p.limit}|${p.resetsAt ?? ""}`;
}

/**
 * Drop consecutive identical readings. **Lossless.**
 *
 * Quota usage is a step function that only moves when you spend tokens, so a
 * day of five-minute polls is mostly repeats. Collapsing a run to its two
 * endpoints keeps every change point *and* the flat segment leading into it,
 * so the curve is bit-for-bit the same shape with a fraction of the samples.
 *
 * This is what gets embedded in the report. Capping before embedding would
 * throw away detail the reader can never get back by zooming in.
 */
export function collapseRuns(points: SeriesPoint[]): SeriesPoint[] {
  if (points.length <= 2) return points;
  const kept: SeriesPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const isEdge = i === 0 || i === points.length - 1;
    const changed = i > 0 && valueKey(points[i]) !== valueKey(points[i - 1]);
    const changesNext =
      i < points.length - 1 &&
      valueKey(points[i]) !== valueKey(points[i + 1]);
    if (isEdge || changed || changesNext) kept.push(points[i]);
  }
  return kept;
}

/**
 * Thin a series to a drawing budget. **Lossy** — a draw-time concern only.
 *
 * Buckets by time and keeps each bucket's peak, so spikes survive the cull;
 * both endpoints are reserved so the visible range never appears clipped.
 */
export function capPoints(
  points: SeriesPoint[],
  maxPoints: number = DEFAULT_MAX_POINTS,
): SeriesPoint[] {
  const cap = Math.max(3, maxPoints);
  if (points.length <= cap) return points;

  const first = points[0];
  const last = points[points.length - 1];
  const interior = points.slice(1, -1);
  const buckets = cap - 2;
  const span = last.t - first.t || 1;

  const picks = new Map<number, SeriesPoint>();
  for (const p of interior) {
    const idx = Math.min(buckets - 1, Math.floor(((p.t - first.t) / span) * buckets));
    const current = picks.get(idx);
    if (!current || p.pct > current.pct) picks.set(idx, p);
  }

  return [first, ...[...picks.values()].sort((a, b) => a.t - b.t), last];
}

/** Both stages, for callers that want a one-shot thinning. */
export function compressPoints(
  points: SeriesPoint[],
  maxPoints: number = DEFAULT_MAX_POINTS,
): SeriesPoint[] {
  return capPoints(collapseRuns(points), maxPoints);
}

/**
 * True when the step from `prev` to `next` looks like a quota reset.
 *
 * Two independent signals, because no single one covers every source:
 *
 *  - Time crossed the reset instant the previous sample announced. This is the
 *    only signal that works when a window resets without any usage in it.
 *  - Usage collapsed. Required because reset times are not always present, and
 *    because gemini's are *rolling* — they drift forward on every poll, so
 *    comparing `resetsAt` for inequality would manufacture a cycle per refresh.
 *
 * The drop test is deliberately blunt: rolling windows let usage decay
 * gradually as old activity ages out, so only a collapse counts, never a dip.
 */
function isCycleBoundary(prev: SeriesPoint, next: SeriesPoint): boolean {
  if (prev.resetsAt) {
    const reset = Date.parse(prev.resetsAt);
    // A *transition* across the announced instant, not a standing comparison:
    // a source that keeps reporting an already-past reset would otherwise make
    // every subsequent sample its own cycle.
    if (!Number.isNaN(reset) && prev.t < reset && next.t >= reset) return true;
  }
  const drop = prev.pct - next.pct;
  return drop >= Math.max(MIN_RESET_DROP, prev.pct * 0.5);
}

function summarise(points: SeriesPoint[]): Cycle {
  const last = points[points.length - 1];
  let peak = points[0];
  for (const p of points) if (p.pct > peak.pct) peak = p;
  return {
    startsAt: points[0].t,
    endsAt: last.t,
    resetsAt: last.resetsAt,
    peakPct: peak.pct,
    peakUsed: peak.used,
    finalUsed: last.used,
    finalRemaining: last.remaining,
    limit: last.limit,
    points,
  };
}

export function splitCycles(points: SeriesPoint[]): Cycle[] {
  if (points.length === 0) return [];
  const cycles: Cycle[] = [];
  let current: SeriesPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (isCycleBoundary(points[i - 1], points[i])) {
      cycles.push(summarise(current));
      current = [];
    }
    current.push(points[i]);
  }
  cycles.push(summarise(current));
  return cycles;
}

const KIND_ORDER: Record<SeriesKind, number> = {
  session: 0,
  weekly: 1,
  submodel: 2,
};

export function buildReport(
  snapshots: QuotaSnapshot[],
  opts: BuildOptions,
): ReportData {
  const maxPoints = opts.maxPoints ?? DEFAULT_MAX_POINTS;
  const ordered = [...snapshots].sort(
    (a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt),
  );

  const bySource = new Map<SourceId, QuotaSnapshot[]>();
  for (const s of ordered) {
    const list = bySource.get(s.source) ?? [];
    list.push(s);
    bySource.set(s.source, list);
  }

  const sources: SourceReport[] = [];

  for (const [source, events] of bySource) {
    const raw = new Map<string, { kind: SeriesKind; label: string; points: SeriesPoint[] }>();
    const outages: Outage[] = [];
    let errorCount = 0;
    let lastCollectedAt: number | undefined;
    let prevError: string | undefined;

    const push = (kind: SeriesKind, label: string, t: number, b: Bucket) => {
      const key = `${kind}:${label}`;
      const entry = raw.get(key) ?? { kind, label, points: [] };
      entry.points.push(toPoint(t, b));
      raw.set(key, entry);
    };

    for (const e of events) {
      const t = Date.parse(e.collectedAt);
      if (Number.isNaN(t)) continue;
      lastCollectedAt = t;

      if (e.error) {
        errorCount++;
        // Extend the current run only if the immediately preceding event was
        // the same failure; a successful collection in between ends the outage.
        const open = outages[outages.length - 1];
        if (open && prevError === e.error) {
          open.to = t;
          open.count++;
        } else {
          outages.push({ from: t, to: t, error: e.error, count: 1 });
        }
        prevError = e.error;
        continue;
      }
      prevError = undefined;

      if (e.session) push("session", "Session", t, e.session);
      if (e.weekly) push("weekly", "Weekly", t, e.weekly);
      for (const sm of e.subModels ?? []) push("submodel", sm.name, t, sm);
    }

    const series: Series[] = [...raw.entries()]
      .map(([key, entry]) => {
        // Lossless only: the range picker needs full detail to zoom into.
        const points = collapseRuns(entry.points);
        return {
          key: `${source}:${key}`,
          source,
          kind: entry.kind,
          label: entry.label,
          limit: points[points.length - 1]?.limit ?? 100,
          points,
          cycles: splitCycles(points),
          latest: points[points.length - 1],
        };
      })
      .sort(
        (a, b) =>
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
          a.label.localeCompare(b.label),
      );

    sources.push({
      source,
      series,
      outages,
      eventCount: events.length,
      errorCount,
      lastCollectedAt,
    });
  }

  sources.sort((a, b) => a.source.localeCompare(b.source));

  return {
    generatedAt: (opts.generatedAt ?? new Date()).toISOString(),
    since: opts.since.getTime(),
    until: opts.until.getTime(),
    days: opts.days,
    totalEvents: ordered.length,
    maxPoints,
    sources,
  };
}
