import { describe, it, expect } from 'vitest';
import { normalizeSnapshot, redact, toLegacySnapshot } from '../../src/observation.js';
import { parseClaudeUsage } from '../../src/claude-usage.js';
const at = '2026-09-27T12:00:00Z';
const scoped = { kind: 'weekly_scoped', group: 'weekly', percent: 92, severity: 'critical', is_active: true, scope: { model: { id: 'fable', display_name: 'Fable' }, surface: null } };
describe('complete observations', () => {
    it('preserves independent units and unknowns without fabricating counts or duplicate limits', () => {
        const raw = { five_hour: { utilization: 58 }, seven_day: { utilization: 74 }, limits: [{ kind: 'session', percent: 58 }, { kind: 'weekly_all', percent: 74 }, scoped], foo_bar: { utilization: 7 }, null_bucket: null, seven_day_breakdown: { rows: [{ key: 'code', percent: 94 }] }, iguana: { utilization: 10, limit_dollars: 250, used_dollars: 25, remaining_dollars: 225 } };
        const o = normalizeSnapshot(parseClaudeUsage(raw, at));
        expect(o.limits.filter(l => l.id === 'session')).toHaveLength(1);
        expect(o.limits.filter(l => l.id === 'weekly')).toHaveLength(1);
        expect(o.limits.find(l => l.label.includes('Fable'))?.measurement).toEqual({ utilizationPct: 92 });
        expect(o.limits.find(l => l.id === 'field:iguana')?.measurement).toMatchObject({ unit: 'currency', currency: 'USD', used: 25, limit: 250, remaining: 225 });
        expect(o.extensions).toMatchObject({ foo_bar: { utilization: 7 }, null_bucket: null, seven_day_breakdown: { rows: [{ key: 'code', percent: 94 }] } });
        expect(o.limits.some(l => l.id.includes('breakdown'))).toBe(false);
        expect(toLegacySnapshot(o).subModels?.some(b => b.name.includes('Fable') && b.pct === 92)).toBe(true);
    });
    it('keeps scoped identity when ordered differently or display name changes with stable model ID', () => {
        const a = normalizeSnapshot(parseClaudeUsage({ limits: [scoped] }, at));
        const b = normalizeSnapshot(parseClaudeUsage({ limits: [{ kind: 'session', percent: 0 }, { ...scoped, scope: { ...scoped.scope, model: { id: 'fable', display_name: 'Renamed' } } }] }, at));
        expect(a.limits[0].id).toEqual(b.limits.find(l => l.label.includes('Renamed'))?.id);
    });
    it('redacts secrets recursively without deleting nulls or normal token usage metrics', () => {
        const value = redact({ nested: [{ accessToken: 'secret', developer_email: 'a@b.c', session_auth_hint: 'secret', token_count: 42 }], null_bucket: null, message: 'Bearer sk-sensitive' });
        expect(JSON.stringify(value)).not.toContain('secret');
        expect(JSON.stringify(value)).not.toContain('a@b.c');
        expect(JSON.stringify(value)).not.toContain('sk-sensitive');
        expect(value).toMatchObject({ nested: [{ token_count: 42 }], null_bucket: null });
    });
    it('normalizes legacy percent snapshots honestly and marks provenance', () => {
        const o = normalizeSnapshot({ source: 'codex', collectedAt: at, session: { used: 13, limit: 100, pct: 13 } });
        expect(o.limits[0].measurement).toEqual({ utilizationPct: 13 });
        expect(o.limits[0].provenance.kind).toBe('legacy');
        expect(o.accountKey).toBe('unknown');
    });
    it('rejects malformed successful responses', () => {
        expect(() => parseClaudeUsage(null, at)).toThrow();
        expect(() => parseClaudeUsage({ five_hour: { utilization: 'oops' } }, at)).toThrow();
    });
});
it('keeps Codex legacy primary/secondary fields while exposing native IDs', async () => {
    const { codexLimits } = await import('../../src/source-mapping.js');
    const limits = codexLimits({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 }, secondary: { usedPercent: 34, windowDurationMins: 10080 } } });
    const o = normalizeSnapshot({ source: 'codex', collectedAt: at, limits });
    expect(toLegacySnapshot(o)).toMatchObject({ session: { pct: 12 }, weekly: { pct: 34 } });
});
it('merges an explicitly known model alias without merging surface-scoped limits', () => {
    const o = normalizeSnapshot(parseClaudeUsage({ seven_day_opus: { utilization: 12 }, limits: [{ kind: 'weekly_scoped', percent: 12, scope: { model: { id: 'opus', display_name: 'Opus' }, surface: null } }, { kind: 'weekly_scoped', percent: 8, scope: { model: { id: 'opus', display_name: 'Opus' }, surface: 'chat' } }] }, at));
    expect(o.limits).toHaveLength(2);
    expect(o.limits.find(l => l.id === 'model:opus:weekly')?.provenance.paths).toHaveLength(2);
});
it('classifies Gemini signed-out redirects as authentication failures', async () => {
    const { classifyError } = await import('../../src/observation.js');
    expect(classifyError('Not signed in — /usage redirected to /app.').kind).toBe('authentication');
});
it('matches status codes as whole numbers only', async () => {
    const { classifyError } = await import('../../src/observation.js');
    expect(classifyError('`codex app-server` exited (1) before answering: error 4013').kind).toBe('unknown');
    expect(classifyError('HTTP 500 at 1429').kind).toBe('unknown');
    expect(classifyError('`codex app-server` reported no rate limit window. Is the Codex CLI signed in?').kind).toBe('parse');
    expect(classifyError('usage API returned HTTP 401').kind).toBe('authentication');
    expect(classifyError('account/rateLimits/read failed: not logged in').kind).toBe('authentication');
    expect(classifyError('usage API rate-limited (HTTP 429)').kind).toBe('rate_limited');
});
