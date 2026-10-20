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
/** One `agy -p "/quota"` row: group, window label, remaining percent, reset text. */
export interface AgyRow {
    group: string;
    window: string;
    remaining: number;
    reset?: string;
    /** From `--output-format json`: the bucket's stable id and window ("weekly", "5h"). */
    bucketId?: string;
    period?: string;
}
/** Rows of the quota table; the CLI prints progress chatter around it, which is skipped. */
export function agyRows(raw: string): AgyRow[] {
    return raw.split('\n').flatMap(line => {
        const [group, window, pct, reset] = line.split('\t').map(x => x.trim());
        const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(pct ?? '');
        if (!group || !window || !m)
            return [];
        return [{ group, window, remaining: Number(m[1]), ...(reset && Number.isFinite(Date.parse(reset)) ? { reset } : {}) }];
    });
}
/**
 * Rows of `agy -p /usage --output-format json` (agy 1.1.11+): the same groups
 * and buckets as the language server's quota summary, in snake case. Undefined
 * when the output is not that document, so the caller can fall back to the
 * text table. Shape as documented by Agent HUD (jazzenchen/agent-hud-open,
 * Apache-2.0), AntigravityCLI.swift.
 */
export function agyUsageRows(json: unknown): AgyRow[] | undefined {
    const doc = json as { status?: unknown; command?: { name?: unknown; data?: { groups?: unknown } } } | undefined;
    if (doc?.status !== 'SUCCESS' || doc.command?.name !== 'usage' || !Array.isArray(doc.command.data?.groups))
        return undefined;
    return doc.command.data.groups.flatMap((g: { name?: unknown; buckets?: unknown }) => {
        const group = typeof g?.name === 'string' ? g.name.trim() : '';
        if (!group || !Array.isArray(g.buckets))
            return [];
        return g.buckets.flatMap((b: { id?: unknown; name?: unknown; window?: unknown; remaining_fraction?: unknown; reset_time?: unknown }) => {
            const fraction = typeof b?.remaining_fraction === 'number' && Number.isFinite(b.remaining_fraction) ? b.remaining_fraction : undefined;
            const window = typeof b?.name === 'string' ? b.name.trim() : typeof b?.window === 'string' ? b.window : '';
            if (fraction === undefined || !window)
                return [];
            const reset = typeof b.reset_time === 'string' && Number.isFinite(Date.parse(b.reset_time)) ? b.reset_time : undefined;
            return [{ group, window, remaining: Math.round(fraction * 10000) / 100, ...(reset ? { reset } : {}), ...(typeof b.id === 'string' ? { bucketId: b.id } : {}), ...(typeof b.window === 'string' ? { period: b.window } : {}) }];
        });
    });
}
/** "Weekly Limit Remaining" -> weekly; "Five Hour", "Five-Hour", "5 hour", "5-hour" -> session. A JSON row's period wins. */
export function agyWindowKind(window: string, period?: string): string {
    if (period === 'weekly' || period === '7d')
        return 'weekly';
    if (period === '5h')
        return 'session';
    return /^weekly/i.test(window) ? 'weekly' : /^(?:five|5)[\s-]*hour/i.test(window) ? 'session' : window;
}
/** Limit ids stay `group:<group>:<window>` whichever output they came from, so history continues across the switch. */
export function antigravityLimitsFromRows(rows: AgyRow[]): QuotaLimit[] {
    return rows.map(({ group, window, remaining, reset, bucketId, period }) => {
        const kind = agyWindowKind(window, period);
        return { id: `group:${group}:${kind}`, label: `${group} · ${kind === 'weekly' ? 'Weekly' : kind === 'session' ? '5-hour' : kind}`, scope: { group }, window: { kind, ...(reset ? { resetsAt: reset } : {}) }, measurement: { utilizationPct: Math.round((100 - remaining) * 100) / 100 }, provenance: { kind: 'derived' as const, paths: [bucketId ? `usage.groups.${group}.buckets.${bucketId}` : `rows.${group}.${window}`], identity: bucketId ? 'stable' as const : 'weak' as const, rule: '100-minus-reported-remaining-v1' }, upstream: { group, window, remaining: `${remaining}%`, reset, ...(bucketId ? { bucketId } : {}) } };
    });
}
export function antigravityLimits(raw: string): QuotaLimit[] {
    return antigravityLimitsFromRows(agyRows(raw));
}
