import { normalizeSnapshot, stableHash, toLegacySnapshot, redact, type QuotaLimit } from './observation.js';
import type { QuotaSnapshot } from './types.js';
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function number(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
// Labels match the "<display_name> · weekly" form the same limits get from `limits[]`.
const aliases: Record<string, [
    string,
    string,
    string
]> = {
    five_hour: ['session', 'Session', 'session'], seven_day: ['weekly', 'Weekly', 'weekly'],
    seven_day_opus: ['model:opus:weekly', 'Opus · weekly', 'weekly'], seven_day_sonnet: ['model:sonnet:weekly', 'Sonnet · weekly', 'weekly'],
    seven_day_omelette: ['model:claude-design:weekly', 'Claude Design · weekly', 'weekly'],
};
export function parseClaudeUsage(raw: unknown, observedAt: string): QuotaSnapshot {
    if (!object(raw))
        throw new Error('failed to parse usage API object');
    const limits = new Map<string, QuotaLimit>();
    for (const [key, value] of Object.entries(raw)) {
        if (!object(value))
            continue;
        const pct = number(value.utilization) ? value.utilization : number(value.percent) ? value.percent : undefined;
        if (pct === undefined)
            continue;
        const alias = aliases[key];
        const id = alias?.[0] ?? `field:${key}`;
        const measurement: QuotaLimit['measurement'] = { utilizationPct: pct };
        if (number(value.limit_dollars) || number(value.used_dollars)) {
            measurement.unit = 'currency';
            measurement.currency = 'USD';
            if (number(value.limit_dollars))
                measurement.limit = value.limit_dollars;
            if (number(value.used_dollars))
                measurement.used = value.used_dollars;
            if (number(value.remaining_dollars))
                measurement.remaining = value.remaining_dollars;
        }
        if (key === 'extra_usage') {
            // Upstream calls these credits; currency does not prove dollar scaling.
            measurement.unit = 'credits';
            if (typeof value.currency === 'string')
                measurement.currency = value.currency;
            if (number(value.used_credits))
                measurement.used = value.used_credits;
            if (number(value.monthly_limit))
                measurement.limit = value.monthly_limit;
        }
        limits.set(id, { id, label: alias?.[1] ?? (key === 'extra_usage' ? `extra_usage_${value.currency ?? 'unknown'}` : key), scope: {}, window: { kind: alias?.[2] ?? 'unknown', ...(typeof value.resets_at === 'string' ? { resetsAt: value.resets_at } : {}) }, measurement, provenance: { kind: 'reported', paths: [key], identity: alias ? 'stable' : 'weak' }, upstream: value });
    }
    if (Array.isArray(raw.limits))
        for (const [index, item] of raw.limits.entries()) {
            if (!object(item))
                continue;
            const pct = number(item.percent) ? item.percent : number(item.utilization) ? item.utilization : undefined;
            if (pct === undefined)
                continue;
            const scope = object(item.scope) ? item.scope : {};
            const model = object(scope.model) ? scope.model : {};
            const kind = typeof item.kind === 'string' ? item.kind : 'unknown';
            const identityScope = { ...scope, ...(object(scope.model) && model.id ? { model: { id: model.id } } : {}) };
            const knownModel = kind === 'weekly_scoped' && scope.surface == null && Object.keys(scope).every(k => k === 'model' || k === 'surface') && ['opus', 'sonnet'].includes(String(model.id)) ? `model:${model.id}:weekly` : undefined;
            const id = kind === 'session' ? 'session' : kind === 'weekly_all' ? 'weekly' : knownModel ?? (typeof item.id === 'string' ? `upstream:${item.id}` : `scoped:${stableHash({ kind, scope: identityScope })}`);
            const prior = limits.get(id);
            limits.set(id, { id, label: typeof model.display_name === 'string' ? `${model.display_name} · ${kind.startsWith('weekly') ? 'weekly' : kind}` : prior?.label ?? kind,
                scope, window: { kind: kind.startsWith('weekly') ? 'weekly' : kind, ...(typeof item.resets_at === 'string' ? { resetsAt: item.resets_at } : prior?.window.resetsAt ? { resetsAt: prior.window.resetsAt } : {}) }, measurement: { utilizationPct: pct },
                provenance: { kind: 'reported', paths: [...(prior?.provenance.paths ?? []), `limits[${index}]`], identity: id === 'session' || id === 'weekly' || item.id || model.id ? 'stable' : 'weak' }, upstream: item });
        }
    if (!limits.size)
        throw new Error('failed to parse usage API: no numeric quota fields');
    const base: QuotaSnapshot = { source: 'claude-code', collectedAt: observedAt, limits: [...limits.values()].sort((a, b) => a.id.localeCompare(b.id)), extensions: redact(raw) as Record<string, unknown>, raw: redact(raw) };
    return { ...toLegacySnapshot(normalizeSnapshot(base)), ...base };
}
