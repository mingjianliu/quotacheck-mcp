import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SourceId,
} from "./types.js";

export async function runCollectors(
  collectors: Collector[],
  ctx: CollectorContext,
  opts: { sources?: SourceId[] } = {},
): Promise<QuotaSnapshot[]> {
  const requested = opts.sources ? new Set(opts.sources) : null;
  const selected = requested
    ? collectors.filter((c) => requested.has(c.source))
    : collectors;

  const results = await Promise.allSettled(selected.map((c) => c.collect(ctx)));

  return results.map((r, i) => {
    const source = selected[i].source;
    if (r.status === "fulfilled") return r.value;
    return {
      source,
      collectedAt: new Date().toISOString(),
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });
}
