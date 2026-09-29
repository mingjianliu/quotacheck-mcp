import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObservationStore } from '../../src/store.js';
import { normalizeSnapshot } from '../../src/observation.js';
import { getHistory, getQuotas } from '../../src/query.js';
const homes: string[] = [];
function setup() { const home = mkdtempSync(join(tmpdir(), 'quota-query-')); homes.push(home); return { home, store: new ObservationStore(home) }; }
const from = '2026-09-27T00:00:00Z', to = '2026-09-28T00:00:00Z';
function sample(time: string, pct: number, account = 'a', reset = '2026-10-01T00:00:00Z') { const o = normalizeSnapshot({ source: 'codex', accountKey: account, collectedAt: time, weekly: { used: pct, limit: 100, pct, resetsAt: reset } }); return o; }
afterEach(() => homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })));
it('pages a frozen set despite backdated observations written between pages', () => {
    const { home, store } = setup();
    store.append(sample('2026-09-27T01:00:00Z', 10));
    store.append(sample('2026-09-27T02:00:00Z', 20));
    const a = getHistory(home, { from, to, pageSize: 1 });
    expect(a.records).toHaveLength(1);
    expect(a.nextCursor).toBeDefined();
    store.append(sample('2026-09-27T01:30:00Z', 15));
    const b = getHistory(home, { from, to, pageSize: 1, cursor: a.nextCursor });
    expect(b.records).toHaveLength(1);
    expect((b.records[0] as any).observedAt).toBe('2026-09-27T02:00:00Z');
    expect(b.nextCursor).toBeUndefined();
    expect(() => getHistory(home, { from, to, cursor: 'garbage' })).toThrow();
    expect(() => getHistory(home, { from, to, cursor: a.nextCursor, sources: ['claude-code'] })).toThrow();
});
it('never aggregates distinct account/reset/unit partitions together', () => {
    const { home, store } = setup();
    store.append(sample('2026-09-27T01:00:00Z', 10));
    store.append(sample('2026-09-27T01:05:00Z', 20));
    store.append(sample('2026-09-27T01:10:00Z', 2, 'b'));
    store.append(sample('2026-09-27T01:20:00Z', 3, 'a', '2026-10-08T00:00:00Z'));
    const result = getHistory(home, { from, to, granularity: '1h' });
    expect(result.records).toHaveLength(3);
    expect(result.records.find((r: any) => r.count === 2)).toMatchObject({ statistics: { utilizationPct: { first: 10, last: 20, min: 10, max: 20 } } });
    expect(result.quality[0].gaps.length).toBeGreaterThan(0);
});
it('returns empty coverage instead of zero usage and validates bounds', () => {
    const { home } = setup();
    const result = getHistory(home, { from, to, sources: ['codex'] });
    expect(result.records).toEqual([]);
    expect(result.quality[0]).toMatchObject({ coverage: 0 });
    expect(() => getHistory(home, { from: to, to: from })).toThrow();
});
it('shows old successful snapshot with stale age and current error independently', () => {
    const { home, store } = setup();
    const o = sample('2026-09-27T01:00:00Z', 20);
    store.writeState({ schemaVersion: 1, sources: { codex: { latest: o, lastSuccessAt: o.observedAt, failures: 1, error: { kind: 'authentication', message: 'sign in' } } } });
    const result = getQuotas(home, { sources: ['codex'] }, new Date(to));
    expect(result.sources[0]).toMatchObject({ freshness: 'stale', error: { kind: 'authentication' }, observation: { limits: [{ measurement: { utilizationPct: 20 } }] } });
});
it('includes raw only on request and applies retention to exact timestamps', () => {
    const { home, store } = setup();
    store.append(sample('2026-09-27T01:00:00Z', 10), { foo: 7 });
    const regular = getHistory(home, { from, to });
    expect((regular.records[0] as any).raw).toBeUndefined();
    const raw = getHistory(home, { from, to, includeRaw: true });
    expect((raw.records[0] as any).raw).toMatchObject({ status: 'available', data: { foo: 7 } });
    expect(() => getHistory(home, { from, to, includeRaw: true, pageSize: 21 })).toThrow();
});
it('reports valid JSON but malformed service state as a storage fault', () => {
    const { home, store } = setup();
    store.writeState({ hello: 'world' });
    expect(getQuotas(home, { sources: ['codex'] })).toMatchObject({ storageError: expect.any(String) });
});
it('invalidates a cursor if retained observations disappeared between pages', () => {
    const { home, store } = setup();
    store.append(sample('2026-09-27T01:00:00Z', 1));
    store.append(sample('2026-09-27T02:00:00Z', 2));
    const page = getHistory(home, { from, to, pageSize: 1 });
    rmSync(join(store.directory, 'observations'), { recursive: true });
    expect(() => getHistory(home, { from, to, pageSize: 1, cursor: page.nextCursor })).toThrow(/expired/i);
});
it('does not expose expired records just because a partial day shard remains on disk', () => {
    const { home, store } = setup();
    const expired = sample('2020-01-01T12:00:00Z', 10);
    store.append(expired, { foo: 7 });
    expect(getHistory(home, { from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' }).records).toEqual([]);
});
