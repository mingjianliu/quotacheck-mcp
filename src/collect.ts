import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { appendHistory } from "./history.js";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SourceId,
} from "./types.js";

function getCachePath(ctx: CollectorContext) {
  return join(ctx.homeDir, ".config", "quotacheck-mcp", "cache.json");
}

function loadCache(
  ctx: CollectorContext,
): Record<string, { snapshot: QuotaSnapshot; ts: number }> {
  try {
    const p = getCachePath(ctx);
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf8"));
    }
  } catch (e) {
    // ignore
  }
  return {};
}

function saveCache(
  ctx: CollectorContext,
  cache: Record<string, { snapshot: QuotaSnapshot; ts: number }>,
) {
  try {
    const p = getCachePath(ctx);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cache, null, 2));
  } catch (e) {
    // ignore
  }
}

/**
 * How stale a last-good snapshot may be before it stops standing in for a
 * failure.
 *
 * The substitution exists to ride out *transient* faults — a 429, a dropped
 * connection. Without a bound it also covers permanent ones: a gemini-web
 * session that expired in June kept being served as the current reading for
 * two months, because every failure re-substituted the same old snapshot. Past
 * this window the error is the honest answer.
 */
export const MAX_STALE_FALLBACK_MS = 60 * 60 * 1000;

export async function runCollectors(
  collectors: Collector[],
  ctx: CollectorContext,
  opts: { sources?: SourceId[]; forceRefresh?: boolean } = {},
): Promise<QuotaSnapshot[]> {
  const requested = opts.sources ? new Set(opts.sources) : null;
  const selected = requested
    ? collectors.filter((c) => requested.has(c.source))
    : collectors;

  const CACHE_TTL = 5 * 60 * 1000;
  const cache = loadCache(ctx);
  const now = Date.now();

  const toRun: Collector[] = [];
  const cachedResults: QuotaSnapshot[] = [];

  for (const c of selected) {
    const cached = cache[c.source];
    const ttl = c.source === "claude-code" ? 60 * 60 * 1000 : CACHE_TTL;
    if (!opts.forceRefresh && cached && now - cached.ts < ttl) {
      cachedResults.push(cached.snapshot);
    } else {
      toRun.push(c);
    }
  }

  const results = await Promise.allSettled(
    toRun.map((c) => {
      const collectorTimeout = 30_000;
      return Promise.race([
        c.collect(ctx),
        new Promise<QuotaSnapshot>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Collector ${c.source} timed out after ${collectorTimeout}ms`,
                ),
              ),
            collectorTimeout,
          ),
        ),
      ]);
    }),
  );

  const recorded: QuotaSnapshot[] = [];

  const freshResults = results.map((r, i) => {
    const source = toRun[i].source;
    let snapshot: QuotaSnapshot;
    if (r.status === "fulfilled") {
      snapshot = r.value;
    } else {
      snapshot = {
        source,
        collectedAt: new Date().toISOString(),
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    }
    // Record what the collector actually returned, before the substitution
    // below can swap a failure for a stale success. History is an audit log:
    // an outage must read as an outage, not as a flat line of unchanged usage.
    recorded.push(snapshot);

    // A collector can fail by rejecting OR by resolving an error snapshot
    // (e.g. claude-code on HTTP 429). When that happens but we hold a prior
    // good snapshot, keep showing it rather than replacing it with the error —
    // the cache exists precisely to ride out transient failures. We still bump
    // `ts` so the TTL backoff applies and we don't immediately re-hit a source
    // whose rate limit escalates on every request.
    // Age is measured from the snapshot's own collectedAt, not the cache entry's
    // `ts`: `ts` is bumped on every failure to drive TTL backoff, so an age
    // derived from it would reset with each failure and never expire.
    const prev = cache[source];
    const prevAge = prev ? now - Date.parse(prev.snapshot.collectedAt) : Infinity;
    if (
      snapshot.error &&
      prev &&
      !prev.snapshot.error &&
      Number.isFinite(prevAge) &&
      prevAge <= MAX_STALE_FALLBACK_MS
    ) {
      cache[source] = { snapshot: prev.snapshot, ts: now };
      return prev.snapshot;
    }
    cache[source] = { snapshot, ts: now };
    return snapshot;
  });

  if (toRun.length > 0) {
    saveCache(ctx, cache);
    if (ctx.historyEnabled !== false) {
      appendHistory(ctx.homeDir, recorded, {
        retentionDays: ctx.historyRetentionDays,
      });
    }
  }

  const result = selected.map((c) => {
    return (
      cachedResults.find((r) => r.source === c.source) ||
      freshResults.find((r) => r.source === c.source)!
    );
  });

  return result.sort((a, b) => a.source.localeCompare(b.source));
}
