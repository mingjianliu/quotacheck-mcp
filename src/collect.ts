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

function loadCache(ctx: CollectorContext): Record<string, { snapshot: QuotaSnapshot, ts: number }> {
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

function saveCache(ctx: CollectorContext, cache: Record<string, { snapshot: QuotaSnapshot, ts: number }>) {
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
  opts: { sources?: SourceId[], forceRefresh?: boolean } = {},
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
    if (!opts.forceRefresh && cached && (now - cached.ts < CACHE_TTL)) {
      cachedResults.push(cached.snapshot);
    } else {
      toRun.push(c);
    }
  }

  const results = await Promise.allSettled(toRun.map((c) => c.collect(ctx)));

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
    // Only cache successful or legitimate error results, but update timestamp anyway
    cache[source] = { snapshot, ts: now };
    return snapshot;
  });

  if (toRun.length > 0) {
    saveCache(ctx, cache);
  }

  return selected.map(c => {
    return cachedResults.find(r => r.source === c.source) || freshResults.find(r => r.source === c.source)!;
  });
}
