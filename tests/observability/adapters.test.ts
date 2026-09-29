import { it, expect } from 'vitest';
import { codexLimits, antigravityLimits, geminiLimits, retryAt } from '../../src/source-mapping.js';
it('maps Codex native limit IDs and windows independently of display names', () => {
    const raw = { rateLimits: {}, rateLimitsByLimitId: { 'meter-a': { limitName: 'Old', primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1790500000 } } } };
    const first = codexLimits(raw);
    raw.rateLimitsByLimitId['meter-a'].limitName = 'New';
    const second = codexLimits(raw);
    expect(first[0].id).toBe(second[0].id);
    expect(first[0].measurement).toEqual({ utilizationPct: 7 });
    expect(first[0].window.kind).toBe('session');
});
it('preserves unknown Gemini tuple fields and distinguishes native bucket codes', () => {
    const limits = geminiLimits([2, [[123, 0.4, 9, [[1790500000, 0]], 'unknown']], false]);
    expect(limits[0].id).toBe('rpc:jSf9Qc:9');
    expect(limits[0].measurement.utilizationPct).toBe(40);
    expect(limits[0].upstream?.row).toContain('unknown');
});
it('marks Antigravity remaining-to-used inversion as derived', () => {
    const limits = antigravityLimits('Group\tWeekly Limit Remaining\t75%\t2026-10-01T00:00:00Z');
    expect(limits[0].measurement.utilizationPct).toBe(25);
    expect(limits[0].provenance.kind).toBe('derived');
});
it('parses Retry-After seconds and HTTP dates without turning invalid headers into immediate retries', () => {
    expect(retryAt('60', 0)).toBe('1970-01-01T00:01:00.000Z');
    expect(retryAt('Thu, 01 Jan 1970 00:02:00 GMT', 0)).toBe('1970-01-01T00:02:00.000Z');
    expect(retryAt('invalid', 0)).toBeUndefined();
});
it('preserves absolute counts in the Gemini HTML fallback', async () => {
  const {parseGeminiWeb}=await import('../../src/collectors/gemini-web.js');
  const {normalizeSnapshot}=await import('../../src/observation.js');
  const snapshot=parseGeminiWeb('<div data-model="test"><span data-used>2</span><span data-limit>10</span></div>',new Date());
  expect(normalizeSnapshot(snapshot).limits[0].measurement).toMatchObject({used:2,limit:10,unit:'count',utilizationPct:20});
});
