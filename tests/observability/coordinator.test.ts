import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../../src/coordinator.js';
import { ObservationStore } from '../../src/store.js';
import type { Collector, CollectorContext, QuotaSnapshot } from '../../src/types.js';
const homes: string[] = [];
const now = Date.parse('2026-09-27T12:00:00Z');
function setup(collectors: Collector[], extra = {}) { const home = mkdtempSync(join(tmpdir(), 'quota-coord-')); homes.push(home); const store = new ObservationStore(home); const ctx: CollectorContext = { homeDir: home, chromeProfilePath: '', playwrightTimeoutMs: 100 }; const c = new Coordinator(collectors, ctx, store, { now: () => now, random: () => 0, ...extra }); return { c, home, store, ctx }; }
afterEach(() => homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })));
describe('single collector scheduling', () => {
    it('coalesces refresh and persists cooldown across a restart', async () => {
        let calls = 0;
        let complete!: (s: QuotaSnapshot) => void;
        const collector: Collector = { source: 'claude-code', collect: async () => { calls++; return new Promise(r => complete = r); } };
        const { c, store, ctx } = setup([collector]);
        expect(c.refresh()[0].status).toBe('accepted');
        expect(c.refresh()[0].status).toBe('coalesced');
        expect(calls).toBe(1);
        complete({ source: 'claude-code', collectedAt: new Date(now).toISOString(), error: 'HTTP 429', collectionError: { kind: 'rate_limited', message: 'HTTP 429', retryAt: new Date(now + 3600000).toISOString() } });
        await c.idle();
        const restarted = new Coordinator([collector], ctx, store, { now: () => now + 1000 });
        expect(restarted.refresh()[0].status).toBe('deferred');
        expect(calls).toBe(1);
        expect(store.read('2026-09-27', '2026-09-28').observations[0].error?.kind).toBe('rate_limited');
    });
    it('pauses authentication failures until explicit retry and isolates sources', async () => {
        let claudeCalls = 0;
        const { c, store } = setup([{ source: 'claude-code', collect: async () => { claudeCalls++; return { source: 'claude-code', collectedAt: new Date(now).toISOString(), error: '401 sign in' }; } }, { source: 'codex', collect: async () => ({ source: 'codex', collectedAt: new Date(now).toISOString(), weekly: { used: 1, limit: 100, pct: 1 } }) }]);
        c.refresh();
        await c.idle();
        c.tick();
        await c.idle();
        expect(claudeCalls).toBe(1);
        expect(store.read('2026-09-27', '2026-09-28').observations).toHaveLength(2);
        c.refresh(['claude-code'], true);
        await c.idle();
        expect(claudeCalls).toBe(2);
    });
    it('does not make a remote request when preflight state cannot be saved', () => {
        let calls = 0;
        const { c, store } = setup([{ source: 'codex', collect: async () => { calls++; throw Error('not reached'); } }]);
        store.ensure();
        mkdirSync(join(store.directory, 'state.json'));
        expect(c.refresh()[0].status).toBe('unavailable');
        expect(calls).toBe(0);
        expect(c.status().storageError).toBeDefined();
    });
    it('refuses corrupted existing scheduling state', () => {
        const { store, ctx } = setup([]);
        store.ensure();
        writeFileSync(join(store.directory, 'state.json'), '{broken');
        expect(() => new Coordinator([], ctx, store)).toThrow();
    });
    it('cancels timed-out collection and records timeout', async () => {
        let aborted = false;
        const { c, store } = setup([{ source: 'codex', collect: async (ctx) => new Promise((_, reject) => ctx.signal!.addEventListener('abort', () => { aborted = true; reject(Error('cancelled')); })) }], { timeoutMs: 10 });
        c.refresh();
        await c.idle();
        expect(aborted).toBe(true);
        expect(store.read('2026-09-27', '2026-09-28').observations[0].error?.kind).toBe('timeout');
    });
});
it('uses source-specific interrupted-request leases rather than freezing all providers for an hour', async () => {
    const { c, store } = setup([{ source: 'codex', collect: async (ctx) => new Promise((_, reject) => ctx.signal!.addEventListener('abort', () => reject(Error('stopped')))) }]);
    c.refresh();
    expect(Date.parse(store.readState<any>()!.sources.codex.nextAllowedAt) - now).toBe(300000);
    await c.stop();
});
it('reports requested but disabled sources explicitly', () => {
  const {c}=setup([]);
  expect(c.refresh(['codex'])).toEqual([{source:'codex',status:'unavailable',reason:'source is disabled'}]);
});
it('recovers a repaired storage fault on restart without discarding cooldown', () => {
    const {store,ctx}=setup([]);
    store.writeState({schemaVersion:1,storageError:'old disk fault',sources:{codex:{failures:1,nextAllowedAt:new Date(now+3600000).toISOString()}}});
    const restarted=new Coordinator([{source:'codex',collect:async()=>{throw Error('must not request');}}],ctx,store,{now:()=>now});
    expect(restarted.refresh(['codex'])[0].status).toBe('deferred');
});
