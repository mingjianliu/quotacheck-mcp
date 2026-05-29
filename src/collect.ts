import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
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
    // A collector can fail by rejecting OR by resolving an error snapshot
    // (e.g. claude-code on HTTP 429). When that happens but we hold a prior
    // good snapshot, keep showing it rather than replacing it with the error —
    // the cache exists precisely to ride out transient failures. We still bump
    // `ts` so the TTL backoff applies and we don't immediately re-hit a source
    // whose rate limit escalates on every request.
    const prev = cache[source];
    if (snapshot.error && prev && !prev.snapshot.error) {
      cache[source] = { snapshot: prev.snapshot, ts: now };
      return prev.snapshot;
    }
    cache[source] = { snapshot, ts: now };
    return snapshot;
  });

  if (toRun.length > 0) {
    saveCache(ctx, cache);
  }

  const result = selected.map((c) => {
    return (
      cachedResults.find((r) => r.source === c.source) ||
      freshResults.find((r) => r.source === c.source)!
    );
  });

  return result.sort((a, b) => a.source.localeCompare(b.source));
}
