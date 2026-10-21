import { getQuotas } from './query.js';
import { ObservationStore } from './store.js';
import type { Observation, QuotaLimit } from './observation.js';
import type { SourceId } from './types.js';

/**
 * A view model for the menu bar panel: everything it shows, worked out here
 * where it can be tested, so the Swift app only draws. Burn rates and
 * projections come from the stored history; nothing is fetched.
 *
 * Colour thresholds and the "will it last until the reset" warning follow
 * Agent HUD (jazzenchen/agent-hud-open): green under 70% used, yellow from
 * 70%, red from 90%, and yellow early when the current pace runs out first.
 */
export type Tier = 'ok' | 'warn' | 'critical';

export interface PanelWindow {
    id: string;
    label: string;
    kind: string;
    /** A shared-limit group (Antigravity's model families, a Codex bucket); rows of one group stay together. */
    group?: string;
    /** The group's display name, shown above its rows; `label` then names the window alone. */
    groupLabel?: string;
    pct: number;
    tier: Tier;
    resetsAt?: string;
    /** Percentage points per hour over the recent part of this cycle. */
    burnPerHour?: number;
    /** Where the current pace lands at the reset, capped at 100. */
    projectedPct?: number;
    /** When the current pace reaches 100%, if before the reset. */
    runsOutAt?: string;
    /** Absolute amounts, for spend limits such as Claude's extra usage. */
    used?: number;
    limit?: number;
    unit?: string;
    currency?: string;
}

export interface PanelSource {
    source: SourceId;
    name: string;
    account?: { label?: string; plan?: string };
    observedAt?: string;
    ageMs?: number;
    freshness: 'fresh' | 'stale' | 'missing';
    error?: { kind: string; message: string };
    nextAllowedAt?: string;
    windows: PanelWindow[];
    resetCredits?: { available: number; firstExpiresAt?: string };
}

export interface Panel {
    generatedAt: string;
    storageError?: string;
    /** The window under most pressure, for the menu bar title. */
    headline?: { source: SourceId; label: string; pct: number; tier: Tier };
    sources: PanelSource[];
}

const NAMES: Record<SourceId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', 'gemini-web': 'Gemini' };
const HOUR = 3600000;
/** Burn rate looks back this far within the current cycle. */
export const RATE_WINDOW_MS = 3 * HOUR;
/** A rate needs readings at least this far apart to mean anything. */
const MIN_RATE_SPAN_MS = 20 * 60000;

function pctOf(l: QuotaLimit): number | undefined {
    const m = l.measurement;
    if (typeof m.utilizationPct === 'number' && Number.isFinite(m.utilizationPct)) return m.utilizationPct;
    if (typeof m.used === 'number' && typeof m.limit === 'number' && m.limit > 0) return m.used / m.limit * 100;
    return undefined;
}

export function tierOf(pct: number, runsOutBeforeReset = false): Tier {
    if (pct >= 90) return 'critical';
    if (pct >= 70 || runsOutBeforeReset) return 'warn';
    return 'ok';
}

const cap = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;

/** Short, source-aware names: "5-hour", "Weekly", "Weekly · Opus", "Spark · 5-hour", "Extra usage". */
export function displayLabel(source: SourceId, l: QuotaLimit): string {
    const kind = l.window.kind === 'session' ? '5-hour' : l.window.kind === 'weekly' ? 'Weekly' : undefined;
    if (source === 'claude-code') {
        if (l.id === 'session') return '5-hour';
        if (l.id === 'weekly') return 'Weekly';
        const model = /^model:([^:]+):weekly$/.exec(l.id)?.[1] ?? (l.window.kind === 'weekly' ? l.label.split(' · ')[0] : undefined);
        if (model && l.window.kind === 'weekly') return `Weekly · ${cap(model === 'claude-design' ? 'Claude Design' : model)}`;
        if (l.label.startsWith('extra_usage')) return 'Extra usage';
        return l.label;
    }
    const group = typeof l.scope.group === 'string' ? l.scope.group : undefined;
    // Codex's own bucket and an unnamed one need no prefix; another bucket keeps its display name.
    if (source === 'codex') return !group || group === 'codex' || group === 'default' ? kind ?? l.label : `${l.label.split(' · ')[0]} · ${kind ?? l.window.kind}`;
    if (group && kind) return `${group} · ${kind}`;
    // Gemini does not say how long its session window is.
    if (source === 'gemini-web' && kind) return l.window.kind === 'session' ? 'Session' : kind;
    return l.label;
}

const ORDER: Record<string, number> = { session: 0, weekly: 1 };

/** Split "Gemini Models · Weekly" into its group heading and the window, for sources whose groups share limits. */
function split(label: string, l: QuotaLimit, source: SourceId): { label: string; groupLabel?: string } {
    const group = typeof l.scope.group === 'string' ? l.scope.group : undefined;
    if (!group || (source === 'codex' && (group === 'codex' || group === 'default'))) return { label };
    const at = label.indexOf(' · ');
    return at > 0 ? { groupLabel: label.slice(0, at), label: label.slice(at + 3) } : { label };
}

interface Point { t: number; pct: number; resetsAt?: number }

/**
 * The readings of the cycle still running: everything after the last reset,
 * which is time passing the reset a reading announced, or usage collapsing.
 */
export function currentCycle(points: Point[]): Point[] {
    let start = 0;
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1], next = points[i];
        const crossed = prev.resetsAt !== undefined && prev.t < prev.resetsAt && next.t >= prev.resetsAt;
        const collapsed = prev.pct - next.pct >= Math.max(20, prev.pct * 0.5);
        if (crossed || collapsed) start = i;
    }
    return points.slice(start);
}

/** Percentage points per hour over the last RATE_WINDOW_MS of the cycle; undefined without enough evidence. */
export function burnRate(points: Point[], now: number): number | undefined {
    const recent = currentCycle(points).filter(p => p.t >= now - RATE_WINDOW_MS && p.t <= now);
    if (recent.length < 2) return undefined;
    const first = recent[0], last = recent[recent.length - 1];
    if (last.t - first.t < MIN_RATE_SPAN_MS) return undefined;
    // Rolling windows let old usage age out; a falling level is no burn, not negative burn.
    return Math.max(0, (last.pct - first.pct) / ((last.t - first.t) / HOUR));
}

function round(n: number, digits = 1) { const f = 10 ** digits; return Math.round(n * f) / f; }

function windowsOf(o: Observation, history: Observation[], now: number): PanelWindow[] {
    const series = (id: string): Point[] => history
        .filter(h => h.accountKey === o.accountKey && !h.error)
        .flatMap(h => {
            const l = h.limits.find(x => x.id === id);
            const pct = l ? pctOf(l) : undefined;
            if (!l || pct === undefined) return [];
            const reset = l.window.resetsAt ? Date.parse(l.window.resetsAt) : NaN;
            return [{ t: Date.parse(h.observedAt), pct, ...(Number.isFinite(reset) ? { resetsAt: reset } : {}) }];
        })
        .sort((a, b) => a.t - b.t);
    return o.limits.flatMap(l => {
        const pct = pctOf(l);
        if (pct === undefined) return [];
        const m = l.measurement;
        const spend = m.unit === 'currency' || m.unit === 'credits';
        const reset = l.window.resetsAt ? Date.parse(l.window.resetsAt) : NaN;
        // Projections only for windows that reset on a schedule; a spend limit has its own meaning.
        const rate = spend ? undefined : burnRate([...series(l.id), { t: Date.parse(o.observedAt), pct }], now);
        let projectedPct: number | undefined, runsOutAt: string | undefined;
        if (rate !== undefined && Number.isFinite(reset) && reset > now) {
            projectedPct = round(Math.min(100, pct + rate * (reset - now) / HOUR));
            if (rate > 0 && pct < 100) {
                const out = now + (100 - pct) / rate * HOUR;
                if (out < reset) runsOutAt = new Date(out).toISOString();
            }
        }
        return [{
            id: l.id, kind: l.window.kind,
            ...split(displayLabel(o.source, l), l, o.source),
            ...(typeof l.scope.group === 'string' ? { group: l.scope.group } : {}),
            pct: round(pct), tier: tierOf(pct, runsOutAt !== undefined),
            ...(l.window.resetsAt ? { resetsAt: l.window.resetsAt } : {}),
            ...(rate !== undefined ? { burnPerHour: round(rate, 2) } : {}),
            ...(projectedPct !== undefined ? { projectedPct } : {}),
            ...(runsOutAt ? { runsOutAt } : {}),
            ...(spend ? { used: m.used, limit: m.limit, unit: m.unit, currency: m.currency } : {}),
        }];
    }).sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || (ORDER[a.kind] ?? 2) - (ORDER[b.kind] ?? 2) || a.label.localeCompare(b.label));
}

function resetCreditsOf(o: Observation): PanelSource['resetCredits'] {
    const summary = (o.extensions.response as { rateLimitResetCredits?: { availableCount?: unknown; credits?: unknown } } | undefined)?.rateLimitResetCredits;
    if (!summary || typeof summary.availableCount !== 'number') return undefined;
    const expiries = Array.isArray(summary.credits)
        ? summary.credits.flatMap((c: { expiresAt?: unknown; status?: unknown }) => typeof c?.expiresAt === 'number' && Number.isFinite(c.expiresAt) ? [c.expiresAt * 1000] : []).sort((a, b) => a - b)
        : [];
    return { available: summary.availableCount, ...(expiries.length ? { firstExpiresAt: new Date(expiries[0]).toISOString() } : {}) };
}

export function getPanel(home: string, now = new Date()): Panel {
    const quotas = getQuotas(home, {}, now);
    const history = new ObservationStore(home).readNew(new Date(now.getTime() - RATE_WINDOW_MS - HOUR).toISOString(), new Date(now.getTime() + 1).toISOString()).observations;
    const sources: PanelSource[] = quotas.sources.map(s => {
        const o = s.observation;
        const account = o?.extensions.account as { label?: unknown; planType?: unknown } | undefined;
        const windows = o ? windowsOf(o, history.filter(h => h.source === s.source), now.getTime()) : [];
        const credits = o ? resetCreditsOf(o) : undefined;
        return {
            source: s.source, name: NAMES[s.source] ?? s.source,
            ...(account && (typeof account.label === 'string' || typeof account.planType === 'string')
                ? { account: { ...(typeof account.label === 'string' ? { label: account.label } : {}), ...(typeof account.planType === 'string' ? { plan: account.planType } : {}) } } : {}),
            ...(o ? { observedAt: o.observedAt, ageMs: s.ageMs } : {}),
            freshness: s.freshness as PanelSource['freshness'],
            ...(s.error ? { error: { kind: s.error.kind, message: s.error.message } } : {}),
            ...(s.nextAllowedAt ? { nextAllowedAt: s.nextAllowedAt } : {}),
            windows,
            ...(credits ? { resetCredits: credits } : {}),
        };
    });
    const rank: Record<Tier, number> = { ok: 0, warn: 1, critical: 2 };
    const all = sources.flatMap(s => s.freshness === 'missing' ? [] : s.windows.filter(w => !w.unit).map(w => ({ source: s.source, label: w.groupLabel ? `${w.groupLabel} · ${w.label}` : w.label, pct: w.pct, tier: w.tier })));
    const headline = all.sort((a, b) => rank[b.tier] - rank[a.tier] || b.pct - a.pct)[0];
    return { generatedAt: now.toISOString(), ...(quotas.storageError ? { storageError: quotas.storageError } : {}), ...(headline ? { headline } : {}), sources };
}
