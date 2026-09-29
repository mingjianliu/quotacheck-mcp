import { createHash, randomUUID } from 'node:crypto';
import type { QuotaSnapshot, SourceId, SubModelBucket } from './types.js';
export type ErrorKind = 'authentication' | 'rate_limited' | 'network' | 'timeout' | 'unsupported' | 'parse' | 'storage' | 'unknown';
export interface CollectionError {
    kind: ErrorKind;
    message: string;
    retryAt?: string;
}
export interface QuotaLimit {
    id: string;
    label: string;
    scope: Record<string, unknown>;
    window: {
        kind: string;
        startsAt?: string;
        resetsAt?: string;
    };
    measurement: {
        utilizationPct?: number;
        used?: number;
        limit?: number;
        remaining?: number;
        unit?: string;
        currency?: string;
    };
    provenance: {
        kind: 'reported' | 'derived' | 'legacy';
        paths: string[];
        rule?: string;
        identity: 'stable' | 'weak';
    };
    upstream?: Record<string, unknown>;
}
export interface Observation {
    schemaVersion: 1;
    observationId: string;
    sequence?: number;
    source: SourceId;
    accountKey: string;
    observedAt: string;
    limits: QuotaLimit[];
    extensions: Record<string, unknown>;
    error?: CollectionError;
    rawRef?: {
        day: string;
        id: string;
        policyVersion: 1;
    };
    rawStatus?: 'disabled' | 'unavailable';
}
export function stableHash(value: unknown): string {
    const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 24);
}
export function redact(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(redact);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, v]) => {
            const sensitive = /authorization|cookie|credential|password|secret|email|auth.?hint|access.?token|refresh.?token|api.?key|session.?token/i.test(key) || /^token$/i.test(key);
            return [key, sensitive ? '[REDACTED]' : redact(v)];
        }));
    if (typeof value === 'string')
        return value.replace(/Bearer\s+[^\s"',]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]');
    return value;
}
export function classifyError(message: string): CollectionError {
    const kind: ErrorKind = /429|rate.limit/i.test(message) ? 'rate_limited'
        : /401|403|keychain|sign.?in|not signed in|signed.?out|session expired|no saved session|captcha/i.test(message) ? 'authentication'
            : /timeout|timed out/i.test(message) ? 'timeout'
                : /unsupported|ENOENT/i.test(message) ? 'unsupported'
                    : /parse|extract quota|no quota rows|no rate limit/i.test(message) ? 'parse'
                        : /network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message) ? 'network' : 'unknown';
    return { kind, message: String(redact(message)) };
}
export function normalizeSnapshot(snapshot: QuotaSnapshot): Observation {
    const limits: QuotaLimit[] = snapshot.limits ?? [];
    if (!snapshot.limits) {
        const rows = [...(snapshot.session ? [{ id: 'session', name: 'Session', b: snapshot.session }] : []),
            ...(snapshot.weekly ? [{ id: 'weekly', name: 'Weekly', b: snapshot.weekly }] : []),
            ...(snapshot.subModels ?? []).map(b => ({ id: `legacy:${b.group ?? ''}:${b.name}`, name: b.name, b }))];
        for (const { id, name, b } of rows)
            limits.push({ id, label: name, scope: {}, window: { kind: id === 'session' || id === 'weekly' ? id : 'unknown', resetsAt: b.resetsAt }, measurement: { utilizationPct: b.pct }, provenance: { kind: 'legacy', paths: [id], identity: 'weak', rule: 'legacy-percent-only-v1' } });
    }
    return redact({ schemaVersion: 1, observationId: randomUUID(), source: snapshot.source, accountKey: snapshot.accountKey ?? 'unknown', observedAt: snapshot.collectedAt, limits, extensions: snapshot.extensions ?? {}, ...(snapshot.error ? { error: snapshot.collectionError ?? classifyError(snapshot.error) } : {}) }) as Observation;
}
export function toLegacySnapshot(o: Observation): QuotaSnapshot {
    const snapshot: QuotaSnapshot = { source: o.source, collectedAt: o.observedAt };
    if (o.error)
        snapshot.error = o.error.message;
    const subs: SubModelBucket[] = [];
    for (const l of o.limits) {
        const m = l.measurement;
        const pct = m.utilizationPct ?? (m.used !== undefined && m.limit ? m.used / m.limit * 100 : undefined);
        if (pct === undefined)
            continue;
        const bucket = { used: m.used ?? pct, limit: m.limit ?? 100, pct, resetsAt: l.window.resetsAt };
        if (l.id === 'session')
            snapshot.session = bucket;
        else if (l.id === 'weekly')
            snapshot.weekly = bucket;
        else if (o.source === 'codex' && new Set(o.limits.map(x => x.scope.group)).size === 1 && l.id.endsWith(':primary'))
            snapshot.session = bucket;
        else if (o.source === 'codex' && new Set(o.limits.map(x => x.scope.group)).size === 1 && l.id.endsWith(':secondary'))
            snapshot.weekly = bucket;
        else
            subs.push({ ...bucket, name: l.label, ...(typeof l.scope.group === 'string' ? { group: l.scope.group } : {}) });
    }
    const response = o.extensions.response as {
        rateLimits?: {
            primary?: {
                usedPercent?: number;
                resetsAt?: number;
            };
            secondary?: {
                usedPercent?: number;
                resetsAt?: number;
            };
        };
    } | undefined;
    if (o.source === 'codex' && response?.rateLimits) {
        for (const [key, slot] of [['session', 'primary'], ['weekly', 'secondary']] as const) {
            const w = response.rateLimits[slot];
            if (typeof w?.usedPercent === 'number' && Number.isFinite(w.usedPercent))
                snapshot[key] = { used: w.usedPercent, limit: 100, pct: w.usedPercent, ...(typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}) };
        }
    }
    if (subs.length)
        snapshot.subModels = subs.sort((a, b) => a.name.localeCompare(b.name));
    return snapshot;
}
