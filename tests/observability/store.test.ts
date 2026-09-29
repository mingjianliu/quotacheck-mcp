import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservationStore } from '../../src/store.js';
import { normalizeSnapshot } from '../../src/observation.js';
import { appendHistory, readHistory } from '../../src/history.js';
const homes: string[] = [];
function setup() { const home = mkdtempSync(join(tmpdir(), 'quota-store-')); homes.push(home); return { home, store: new ObservationStore(home) }; }
const obs = () => normalizeSnapshot({ source: 'claude-code', collectedAt: '2026-09-27T12:00:00Z', weekly: { used: 12, limit: 100, pct: 12 } });
afterEach(() => homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })));
describe('observation storage', () => {
    it('round trips redacted raw and unchanged observations, reporting damaged lines', () => {
        const { store } = setup();
        const o = obs();
        store.append(o, { foo: null, accessToken: 'secret' });
        store.append(obs(), { foo: 7 });
        expect(store.readRaw(o)).toMatchObject({ status: 'available', data: { foo: null, accessToken: '[REDACTED]' } });
        const file = join(store.directory, 'observations', '2026-09-27.jsonl');
        appendFileSync(file, '{"broken":');
        const result = store.read('2026-09-27T00:00:00Z', '2026-09-28T00:00:00Z');
        expect(result.observations).toHaveLength(2);
        expect(result.corruptLines).toBe(1);
        expect(readFileSync(file, 'utf8')).not.toContain('secret');
    });
    it('reports corrupt state instead of resetting cooldown and replaces state atomically', () => {
        const { store } = setup();
        store.writeState({ nextAllowedAt: '2026-09-28' });
        expect(store.readState()).toEqual({ nextAllowedAt: '2026-09-28' });
        writeFileSync(join(store.directory, 'state.json'), '{bad');
        expect(() => store.readState()).toThrow();
    });
    it('compresses closed days, expires raw independently and keeps legacy history accessible', async () => {
        const { store, home } = setup();
        const o = obs();
        store.append(o, { foo: 7 });
        appendHistory(home, [{ source: 'codex', collectedAt: o.observedAt, weekly: { used: 3, limit: 100, pct: 3 } }], { now: new Date(o.observedAt) });
        await store.maintain(new Date('2026-09-29T00:00:00Z'), { retentionDays: 90, rawRetentionDays: 1 });
        expect(readdirSync(join(store.directory, 'observations'))).toContain('2026-09-27.jsonl.gz');
        expect(store.readRaw(o).status).toBe('expired');
        expect(store.read('2026-09-27T00:00:00Z', '2026-09-28T00:00:00Z').observations).toHaveLength(2);
        expect(readHistory(home, { since: new Date('2026-09-27'), until: new Date('2026-09-28') })).toHaveLength(2);
    });
    it('repairs an incomplete tail before appending the next record', () => {
        const { store } = setup();
        store.append(obs());
        appendFileSync(join(store.directory, 'observations', '2026-09-27.jsonl'), '{broken');
        store.append(obs());
        expect(store.read('2026-09-27', '2026-09-28').observations).toHaveLength(2);
    });
});
it('compresses closed files asynchronously and retains backdated additions', async () => {
    const { store } = setup();
    store.append(obs());
    const pending = store.maintain(new Date('2026-09-29'));
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    store.append(obs());
    await store.maintain(new Date('2026-09-29'));
    expect(store.read('2026-09-27', '2026-09-28').observations).toHaveLength(2);
});
