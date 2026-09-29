import type { QuotaLimit } from './observation.js';
import type { AccountRateLimits, RateLimitSnapshot } from './collectors/codex.js';
export function retryAt(value: string | undefined, now = Date.now()): string | undefined {
    if (!value)
        return undefined;
    const t = /^\d+(\.\d+)?$/.test(value.trim()) ? now + Number(value) * 1000 : Date.parse(value);
    return Number.isFinite(t) ? new Date(Math.max(now, t)).toISOString() : undefined;
}
export function codexLimits(raw: AccountRateLimits): QuotaLimit[] {
    const mapped = raw.rateLimitsByLimitId;
    const buckets: Record<string, RateLimitSnapshot> = mapped && Object.keys(mapped).length ? mapped : { default: raw.rateLimits ?? {} };
    const result: QuotaLimit[] = [];
    for (const [key, b] of Object.entries(buckets))
        for (const slot of ['primary', 'secondary'] as const) {
            const w = b?.[slot];
            if (!w || !Number.isFinite(w.usedPercent))
                continue;
            const kind = w.windowDurationMins === 10080 ? 'weekly' : w.windowDurationMins === 300 ? 'session' : slot;
            const resetsAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000).toISOString() : undefined;
            result.push({ id: `meter:${b.limitId ?? key}:${slot}`, label: `${b.limitName ?? b.limitId ?? key} · ${kind}`, scope: { group: b.limitId ?? key }, window: { kind, resetsAt }, measurement: { utilizationPct: w.usedPercent }, provenance: { kind: 'reported', paths: [mapped ? `rateLimitsByLimitId.${key}.${slot}` : `rateLimits.${slot}`], identity: key === 'default' ? 'weak' : 'stable' }, upstream: { ...w } });
        }
    return result;
}
export function geminiLimits(payload: unknown): QuotaLimit[] {
    if (!Array.isArray(payload) || !Array.isArray(payload[1]))
        return [];
    return payload[1].flatMap((row: unknown, index: number) => {
        if (!Array.isArray(row) || typeof row[1] !== 'number' || !Number.isFinite(row[1]) || typeof row[2] !== 'number')
            return [];
        const code = row[2], kind = code === 1 ? 'session' : code === 2 ? 'weekly' : 'unknown';
        const sec = row[3]?.[0]?.[0];
        return [{ id: `rpc:jSf9Qc:${code}`, label: code === 1 ? 'session quota' : code === 2 ? 'weekly quota' : `gemini-model-${code}`, scope: { bucketCode: code }, window: { kind, ...(typeof sec === 'number' && Number.isFinite(sec) ? { resetsAt: new Date(sec * 1000).toISOString() } : {}) }, measurement: { utilizationPct: row[1] * 100 }, provenance: { kind: 'derived' as const, paths: [`jSf9Qc[1][${index}]`], rule: 'consumed-fraction-times-100-v1', identity: 'stable' as const }, upstream: { row } }];
    });
}
export function antigravityLimits(raw: string): QuotaLimit[] {
    return raw.split('\n').flatMap(line => {
        const [group, window, pct, reset] = line.split('\t').map(x => x.trim());
        if (!group || !window || !/^\d+(\.\d+)?%$/.test(pct ?? ''))
            return [];
        const kind = /weekly/i.test(window) ? 'weekly' : /five hour|5 hour/i.test(window) ? 'session' : window;
        return [{ id: `group:${group}:${kind}`, label: `${group} · ${kind === 'weekly' ? 'Weekly' : kind === 'session' ? '5-hour' : kind}`, scope: { group }, window: { kind, ...(reset && Number.isFinite(Date.parse(reset)) ? { resetsAt: reset } : {}) }, measurement: { utilizationPct: Math.round((100 - parseFloat(pct)) * 100) / 100 }, provenance: { kind: 'derived' as const, paths: [`rows.${group}.${window}`], identity: 'weak' as const, rule: '100-minus-reported-remaining-v1' }, upstream: { group, window, remaining: pct, reset } }];
    });
}
