# Quota Usage History — Design

Date: 2026-08-23
Status: approved

## Problem

`runCollectors` persists only the latest snapshot per source to
`~/.config/quotacheck-mcp/cache.json`, overwriting it on every refresh. There is
no way to answer "how did my Claude Code weekly quota move over the last week?"
or "when did the session window actually reset?".

## Goal

Record every real collection over a retention window, and render it as a
self-contained HTML report showing, per quota bucket: usage and remaining over
time, the quota reset instants, and a per-cycle summary.

## Decisions

| Axis | Choice |
|---|---|
| Surface | HTML report only. No new MCP tool, no SwiftUI change. |
| Granularity | Every real collection (cache hits excluded). |
| Retention | `historyRetentionDays`, default 90. |

## Storage

Append-only JSONL sharded by month:

```
~/.config/quotacheck-mcp/history/2026-08.jsonl
```

Each line is a `QuotaSnapshot` verbatim — it already carries `source` and
`collectedAt`, so no wrapper object is added. Error snapshots are recorded too,
`error` field intact: a gap in the curve must be distinguishable from "collector
was broken".

Monthly sharding is load-bearing. At 4 sources x one collection per 5 minutes,
the log grows ~1150 lines/day (~40-50MB over 90 days). Pruning a single file of
that size on every write is not viable; with shards, append stays O(1) and
pruning is `unlink` of whole expired shards.

## Recording hook

In `src/collect.ts`, inside the `freshResults` map, **before** the last-good
cache substitution. That substitution replaces a fresh error with a previous
good snapshot; recording after it would write stale data stamped as fresh.
History must record what actually happened.

Cache hits are not recorded. All three entry points (MCP server, `export-json.ts`
used by the macOS app, `smoke.ts`) inherit history for free.

## Retention

Config gains `historyRetentionDays` (default 90) and `historyEnabled`
(default true).

Pruning runs at most once per hour, gated on shard mtime rather than extra
state. Only shards whose entire month falls before the cutoff are deleted; a
partially-expired shard is kept whole. Up to ~30 extra days may sit on disk as a
result. Reads filter by exact cutoff, so query results are unaffected. This
trades a little disk for an append path that is always O(1).

## Report pipeline

`npm run report -- --days 7 [--sources a,b] [--out path.html]`

1. Read only the shards intersecting the window; filter by exact cutoff.
2. Flatten to one series per (source, bucket), where bucket is `session`,
   `weekly`, or `submodel:<name>`.
3. Compress: usage is a step function, so collapse runs of identical
   `(used, limit, resetsAt)`. Fallback hard cap of 600 points per series,
   bucketed by time taking the peak.
4. Split cycles: a change in `resetsAt` marks the end of one quota cycle and the
   start of the next. `resetsAt` is authoritative — more reliable than inferring
   a reset from a drop in usage.
5. Emit one self-contained HTML file with data inlined, no external requests.

`src/report/aggregate.ts` holds the pure transforms and is unit-tested;
`src/report/render.ts` does HTML only.

## Report contents

Per source:

- Step-line chart, x = time, y = usage %, with vertical markers at reset instants.
- Cycle summary table: cycle start | cycle end (= reset) | peak usage | final usage | remaining.
- Recent-refresh table: refresh time | used | remaining | next reset.

## Files

| File | Action |
|---|---|
| `src/history.ts` | new — append / read(range) / prune / shard paths |
| `src/report/aggregate.ts` | new — pure data transforms |
| `src/report/render.ts` | new — HTML rendering |
| `scripts/report.ts` | new — CLI |
| `src/collect.ts` | add recording hook before cache substitution |
| `src/config.ts` | add `historyRetentionDays`, `historyEnabled` |
| `src/types.ts` | series and cycle types |
| `package.json`, `README.md` | `report` script, docs |

## Tests

- Shard rollover across a month boundary.
- Exact cutoff filtering on read.
- Prune deletes only fully-expired shards.
- Malformed line is skipped, not fatal.
- Compression preserves every change point.
- Cycle splitting from `resetsAt` transitions.
- `collect.test.ts`: history records the real error snapshot, not the
  cache-substituted good one.

## Out of scope

MCP query tool, SwiftUI history view, cross-source aggregation, alerting.
