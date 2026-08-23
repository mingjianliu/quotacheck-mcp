import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { QuotaSnapshot, SourceId } from "./types.js";

export const DEFAULT_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const SHARD_RE = /^(\d{4})-(\d{2})\.jsonl$/;

export function historyDir(homeDir: string): string {
  return join(homeDir, ".config", "quotacheck-mcp", "history");
}

/** Shard key for an instant, in UTC so it never depends on the local zone. */
function shardKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Half-open [start, end) bounds of the month a shard covers, in epoch ms. */
function shardRange(file: string): { start: number; end: number } | null {
  const m = SHARD_RE.exec(file);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return {
    start: Date.UTC(year, month - 1, 1),
    end: Date.UTC(year, month, 1),
  };
}

function listShards(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => SHARD_RE.test(f));
  } catch {
    return [];
  }
}

function eventTime(snapshot: QuotaSnapshot): number {
  const t = Date.parse(snapshot.collectedAt);
  return Number.isNaN(t) ? Date.now() : t;
}

/**
 * Append snapshots to the month shard their `collectedAt` falls in.
 *
 * Snapshots are written verbatim — including `error` — so a flat line in the
 * report can be told apart from a collector that was down. Failures here are
 * swallowed: losing a history line must never take down a quota check.
 */
export function appendHistory(
  homeDir: string,
  snapshots: QuotaSnapshot[],
  opts: { retentionDays?: number; now?: Date } = {},
): void {
  if (snapshots.length === 0) return;
  const dir = historyDir(homeDir);

  const byShard = new Map<string, string[]>();
  for (const s of snapshots) {
    const key = shardKey(new Date(eventTime(s)));
    const lines = byShard.get(key) ?? [];
    lines.push(JSON.stringify(s));
    byShard.set(key, lines);
  }

  try {
    mkdirSync(dir, { recursive: true });
    for (const [key, lines] of byShard) {
      appendFileSync(join(dir, `${key}.jsonl`), lines.join("\n") + "\n");
    }
  } catch {
    return; // nothing written, so nothing to prune either
  }

  pruneHistory(
    homeDir,
    opts.retentionDays ?? DEFAULT_RETENTION_DAYS,
    opts.now ?? new Date(),
  );
}

/**
 * Delete shards that lie entirely before the cutoff.
 *
 * A partially-expired shard is kept whole: rewriting a multi-megabyte file on
 * every collection is not worth it, and `readHistory` filters by exact cutoff
 * anyway, so queries never see the extra days.
 */
export function pruneHistory(
  homeDir: string,
  retentionDays: number,
  now: Date = new Date(),
): number {
  const dir = historyDir(homeDir);
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  let deleted = 0;
  for (const file of listShards(dir)) {
    const range = shardRange(file);
    if (!range || range.end > cutoff) continue;
    try {
      unlinkSync(join(dir, file));
      deleted++;
    } catch {
      // a shard we cannot delete is not worth failing a collection over
    }
  }
  return deleted;
}

export interface HistoryQuery {
  since: Date;
  until?: Date;
  sources?: SourceId[];
}

/**
 * Read recorded snapshots in [since, until], oldest first.
 *
 * Only shards overlapping the window are opened, and malformed lines are
 * skipped — a truncated final line from an interrupted write must not make the
 * whole history unreadable.
 */
export function readHistory(
  homeDir: string,
  query: HistoryQuery,
): QuotaSnapshot[] {
  const dir = historyDir(homeDir);
  if (!existsSync(dir)) return [];

  const since = query.since.getTime();
  const until = query.until ? query.until.getTime() : Infinity;
  const wanted = query.sources ? new Set<string>(query.sources) : null;

  const out: QuotaSnapshot[] = [];
  for (const file of listShards(dir)) {
    const range = shardRange(file);
    if (!range || range.end <= since || range.start > until) continue;

    let raw: string;
    try {
      raw = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }

    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let snapshot: QuotaSnapshot;
      try {
        snapshot = JSON.parse(line) as QuotaSnapshot;
      } catch {
        continue;
      }
      if (!snapshot || typeof snapshot.collectedAt !== "string") continue;
      const t = Date.parse(snapshot.collectedAt);
      if (Number.isNaN(t) || t < since || t > until) continue;
      if (wanted && !wanted.has(snapshot.source)) continue;
      out.push(snapshot);
    }
  }

  return out.sort(
    (a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt),
  );
}
