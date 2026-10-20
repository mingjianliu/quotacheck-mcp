import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { ObservationStore } from './store.js';
import { ALL_SOURCES, type SourceId, type QuotaSnapshot } from './types.js';
import { normalizeSnapshot, stableHash, toLegacySnapshot, type Observation } from './observation.js';
import type { ServiceState } from './coordinator.js';
const source = z.enum(ALL_SOURCES as [
    SourceId,
    ...SourceId[]
]);
export const FilterSchema = z.object({ sources: z.array(source).optional(), accountKeys: z.array(z.string()).optional(), limitIds: z.array(z.string()).optional() }).strict();
const instant = z.string().refine(v => /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)), 'Expected ISO timestamp with timezone');
export const HistorySchema = FilterSchema.extend({ from: instant, to: instant, granularity: z.enum(['raw', '5m', '30m', '1h', '1d']).default('raw'), cursor: z.string().max(8192).optional(), pageSize: z.number().int().min(1).max(1000).optional(), includeRaw: z.boolean().default(false) })
    .refine(v => Date.parse(v.from) < Date.parse(v.to), 'from must precede to')
    .refine(v => !v.includeRaw || (v.pageSize ?? 20) <= 20, 'includeRaw allows at most 20 records')
    .refine(v => !v.includeRaw || v.granularity === 'raw', 'includeRaw requires raw granularity');
type Filters = z.infer<typeof FilterSchema>;
function filtered(o: Observation, f: Filters): Observation | undefined {
    if (f.sources && !f.sources.includes(o.source) || f.accountKeys && !f.accountKeys.includes(o.accountKey))
        return undefined;
    const limits = f.limitIds ? o.limits.filter(l => f.limitIds!.includes(l.id)) : o.limits;
    if (f.limitIds && !limits.length)
        return undefined;
    return { ...o, limits };
}
function stateOf(store: ObservationStore): {
    state: ServiceState;
    error?: string;
} {
    try {
        const state = store.readState<ServiceState>();
        if (state !== undefined && (!state || state.schemaVersion !== 1 || !state.sources || typeof state.sources !== 'object' || Array.isArray(state.sources)))
            throw Error('Invalid state schema');
        return { state: state ?? { schemaVersion: 1, sources: {} } };
    }
    catch (e) {
        return { state: { schemaVersion: 1, sources: {} }, error: `Cannot read scheduling state: ${String(e)}` };
    }
}
export function getStatus(home: string, sources?: SourceId[], now = new Date()) {
    const cfg = loadConfig({ homeDir: home }), store = new ObservationStore(home), { state, error } = stateOf(store);
    return { schemaVersion: 1, daemon: state.heartbeatAt && now.getTime() - Date.parse(state.heartbeatAt) < 30000 ? 'recent_heartbeat' : 'offline', heartbeatAt: state.heartbeatAt, pid: state.pid, storageError: error ?? state.storageError,
        historyEnabled: cfg.historyEnabled, retentionDays: cfg.historyRetentionDays, rawEnabled: cfg.rawEnabled, rawRetentionDays: cfg.rawRetentionDays,
        sources: (sources ?? cfg.enabledSources).map(source => ({ source, enabled: cfg.enabledSources.includes(source), intervalMs: cfg.collectionIntervals[source] ?? cfg.collectionIntervalMs,
            credentialSupport: 'requires-local-login', ...(state.sources[source] ?? {}) })).map(({ latest, ...s }) => ({ ...s, lastObservationId: latest?.observationId })) };
}
export function getQuotas(home: string, input: unknown = {}, now = new Date()) {
    const filters = FilterSchema.parse(input), cfg = loadConfig({ homeDir: home }), store = new ObservationStore(home), { state, error } = stateOf(store);
    let legacy: Record<string, {
        snapshot: QuotaSnapshot;
    }> = {};
    const cache = join(store.directory, 'cache.json');
    if (existsSync(cache)) {
        try {
            legacy = JSON.parse(readFileSync(cache, 'utf8'));
        }
        catch { /* untrusted legacy cache */ }
    }
    const sources = (filters.sources ?? cfg.enabledSources).map(source => {
        const s = state.sources[source];
        const old = !s?.latest && legacy[source]?.snapshot;
        const original = s?.latest ?? (old ? normalizeSnapshot(old) : undefined);
        const observation = original ? filtered(original, filters) : undefined;
        const age = observation ? Math.max(0, now.getTime() - Date.parse(observation.observedAt)) : undefined;
        return { source, observation, freshness: observation ? (old || age! > cfg.staleAfterMs ? 'stale' : 'fresh') : 'missing', ageMs: age, lastAttemptAt: s?.lastAttemptAt, lastSuccessAt: s?.lastSuccessAt, nextAllowedAt: s?.nextAllowedAt, error: s?.error };
    });
    return { schemaVersion: 1, generatedAt: now.toISOString(), storageError: error ?? state.storageError, sources };
}
export function getLegacyQuotas(home: string, sources?: SourceId[]): QuotaSnapshot[] {
    return getQuotas(home, { sources }).sources.map(s => {
        const o = s.observation;
        if (!o)
            return { source: s.source, collectedAt: new Date().toISOString(), error: s.error?.message ?? 'No observation. Start quotacheck daemon.' };
        const legacy = toLegacySnapshot(o);
        if (s.freshness === 'stale')
            legacy.error = `Stale observation from ${o.observedAt}${s.error ? `; ${s.error.message}` : ''}`;
        return legacy;
    });
}
export interface Quality {
    source: SourceId;
    expectedIntervalMs: number;
    expectedSlots: number;
    observedSlots: number;
    coverage: number;
    gaps: {
        from: string;
        to: string;
        reason: 'unknown' | 'collection_failure';
    }[];
}
function quality(observations: Observation[], sources: SourceId[], from: number, to: number, intervals: Record<string, number>, interval: number, gapMs: number): Quality[] {
    return sources.map(source => {
        const step = intervals[source] ?? interval;
        const successful = observations.filter(o => o.source === source && !o.error).map(o => Date.parse(o.observedAt)).sort((a, b) => a - b);
        const expectedSlots = Math.ceil((to - from) / step), observedSlots = new Set(successful.map(t => Math.floor((t - from) / step))).size;
        const anchors = [from, ...successful, to], gaps: Quality['gaps'] = [];
        for (let i = 1; i < anchors.length; i++) {
            const a = anchors[i - 1], b = anchors[i];
            if (b - a >= gapMs) {
                const failure = observations.some(o => o.source === source && o.error && Date.parse(o.observedAt) >= a && Date.parse(o.observedAt) < b);
                gaps.push({ from: new Date(a).toISOString(), to: new Date(b).toISOString(), reason: failure ? 'collection_failure' : 'unknown' });
            }
        }
        return { source, expectedIntervalMs: step, expectedSlots, observedSlots, coverage: expectedSlots ? observedSlots / expectedSlots : 0, gaps };
    });
}
interface Aggregate {
    source: SourceId;
    accountKey: string;
    limitId: string;
    label: string;
    from: string;
    to: string;
    cycle: string;
    unit?: string;
    currency?: string;
    count: number;
    firstObservedAt: string;
    lastObservedAt: string;
    statistics: Record<string, {
        first: number;
        last: number;
        min: number;
        max: number;
    }>;
}
function aggregate(observations: Observation[], step: number, from: number, to: number): Aggregate[] {
    const groups = new Map<string, Aggregate>();
    for (const o of observations) {
        if (o.error)
            continue;
        for (const l of o.limits) {
            const t = Date.parse(o.observedAt), start = Math.floor(t / step) * step;
            // Unknown cycles are not assumed equal: retain each observation separately.
            const cycle = l.window.resetsAt ?? 'unknown';
            const key = JSON.stringify([o.source, o.accountKey, l.id, l.measurement.unit, l.measurement.currency, cycle === 'unknown' ? o.observationId : cycle, start]);
            let a = groups.get(key);
            if (!a) {
                a = { source: o.source, accountKey: o.accountKey, limitId: l.id, label: l.label, from: new Date(Math.max(start, from)).toISOString(), to: new Date(Math.min(start + step, to)).toISOString(), cycle, unit: l.measurement.unit, currency: l.measurement.currency, count: 0, firstObservedAt: o.observedAt, lastObservedAt: o.observedAt, statistics: {} };
                groups.set(key, a);
            }
            a.count++;
            a.lastObservedAt = o.observedAt;
            for (const [name, value] of Object.entries(l.measurement)) {
                if (typeof value !== 'number')
                    continue;
                const s = a.statistics[name];
                if (s) {
                    s.last = value;
                    s.min = Math.min(s.min, value);
                    s.max = Math.max(s.max, value);
                }
                else
                    a.statistics[name] = { first: value, last: value, min: value, max: value };
            }
        }
    }
    return [...groups.values()].sort((a, b) => a.from.localeCompare(b.from) || JSON.stringify([a.source, a.accountKey, a.limitId, a.cycle, a.unit, a.currency]).localeCompare(JSON.stringify([b.source, b.accountKey, b.limitId, b.cycle, b.unit, b.currency])));
}
export function getHistory(home: string, input: unknown) {
    const q = HistorySchema.parse(input), cfg = loadConfig({ homeDir: home }), store = new ObservationStore(home);
    const pageSize = q.pageSize ?? (q.includeRaw ? 20 : 100);
    const { cursor, ...params } = q;
    const queryHash = stableHash(params);
    let marker: {
        hash: string;
        maxSequence: number;
        offset: number;
        legacyDigest: string;
        snapshotDigest: string;
    } | undefined;
    if (cursor) {
        try {
            marker = JSON.parse(Buffer.from(cursor, 'base64url').toString());
            if (!marker || marker.hash !== queryHash || !Number.isSafeInteger(marker.maxSequence) || !Number.isSafeInteger(marker.offset) || marker.offset < 0 || typeof marker.legacyDigest !== 'string' || typeof marker.snapshotDigest !== 'string')
                throw Error();
        }
        catch {
            throw Error('Invalid cursor or changed query');
        }
    }
    const from = Date.parse(q.from), to = Date.parse(q.to);
    const retentionCutoff = new Date(Date.now() - cfg.historyRetentionDays * 86400000).toISOString();
    const data = store.read(q.from, q.to);
    let observations = data.observations.filter(o => Date.parse(o.observedAt) >= Date.parse(retentionCutoff));
    const maxSequence = marker?.maxSequence ?? observations.reduce((max, o) => Math.max(max, o.sequence ?? 0), 0);
    const legacyDigest = stableHash(observations.filter(o => o.sequence === undefined).map(o => o.observationId));
    if (marker && marker.legacyDigest !== legacyDigest)
        throw Error('Cursor expired: legacy history changed');
    const snapshotDigest = stableHash(observations.filter(o => o.sequence !== undefined && o.sequence <= maxSequence).map(o => o.observationId));
    if (marker && marker.snapshotDigest !== snapshotDigest)
        throw Error('Cursor expired: retained observations changed');
    observations = observations.filter(o => o.sequence === undefined || o.sequence <= maxSequence).flatMap(o => { const f = filtered(o, q); return f ? [f] : []; });
    const qualityResult = quality(observations, q.sources ?? [...new Set([...cfg.enabledSources, ...observations.map(o => o.source)])], from, to, cfg.collectionIntervals, cfg.collectionIntervalMs, cfg.staleAfterMs);
    const steps = { '5m': 300000, '30m': 1800000, '1h': 3600000, '1d': 86400000 };
    const records: Array<Observation | Aggregate | Record<string, unknown>> = q.granularity === 'raw' ? observations : aggregate(observations, steps[q.granularity], from, to);
    const offset = marker?.offset ?? 0;
    const page = records.slice(offset, offset + pageSize).map(r => {
        if (!q.includeRaw)
            return r;
        const raw = Date.parse((r as Observation).observedAt) < Date.now() - cfg.rawRetentionDays * 86400000 ? { status: "expired" } : store.readRaw(r as Observation);
        return { ...r, raw: JSON.stringify(raw).length > 262144 ? { status: 'rawTooLarge', exportCommand: `quotacheck export ${(r as Observation).observationId}` } : raw };
    });
    const nextCursor = offset + pageSize < records.length ? Buffer.from(JSON.stringify({ hash: queryHash, maxSequence, offset: offset + pageSize, legacyDigest, snapshotDigest })).toString('base64url') : undefined;
    return { schemaVersion: 1, from: q.from, to: q.to, granularity: q.granularity, records: page, nextCursor, quality: qualityResult, retentionCutoff, corruptLines: data.corruptLines };
}
