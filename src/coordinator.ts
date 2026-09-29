import { randomUUID } from 'node:crypto';
import type { Collector, CollectorContext, SourceId, QuotaSnapshot } from './types.js';
import { classifyError, normalizeSnapshot, type Observation, type CollectionError } from './observation.js';
import { ObservationStore } from './store.js';
export interface SourceState {
    lastAttemptAt?: string;
    lastSuccessAt?: string;
    nextAllowedAt?: string;
    error?: CollectionError;
    failures: number;
    needsAuthentication?: boolean;
    latest?: Observation;
    requestId?: string;
}
export interface ServiceState {
    schemaVersion: 1;
    heartbeatAt?: string;
    pid?: number;
    storageError?: string;
    sources: Partial<Record<SourceId, SourceState>>;
}
export interface RefreshResult {
    source: SourceId;
    status: 'accepted' | 'coalesced' | 'deferred' | 'unavailable';
    requestId?: string;
    nextAllowedAt?: string;
    reason?: string;
}
export class Coordinator {
    private state: ServiceState;
    private running = new Map<SourceId, Promise<void>>();
    private controllers = new Map<SourceId, AbortController>();
    private stopped = false;
    private now: () => number;
    constructor(private collectors: Collector[], private ctx: CollectorContext, private store: ObservationStore, private options: {
        now?: () => number;
        random?: () => number;
        timeoutMs?: number;
        intervalMs?: number;
        intervals?: Partial<Record<SourceId, number>>;
    } = {}) {
        this.now = options.now ?? Date.now;
        const state = store.readState<ServiceState>();
        if (state !== undefined && (!state || state.schemaVersion !== 1 || !state.sources || typeof state.sources !== 'object' || Array.isArray(state.sources)))
            throw Error('Corrupt scheduling state; collection stopped');
        if (state)
            for (const s of Object.values(state.sources)) {
                if (!s || !Number.isFinite(s.failures) || (s.nextAllowedAt && !Number.isFinite(Date.parse(s.nextAllowedAt))))
                    throw Error('Corrupt scheduling deadline; collection stopped');
            }
        this.state = state ?? { schemaVersion: 1, sources: {} };
        // Startup will test storage again before any request; preserve all deadlines.
        this.state.storageError = undefined;
    }
    status(): ServiceState { return structuredClone(this.state); }
    private persist() { this.state.heartbeatAt = new Date(this.now()).toISOString(); this.state.pid = process.pid; try {
        this.store.writeState(this.state);
    }
    catch (e) {
        this.state.storageError = `Storage fault: ${String(e)}`;
        throw e;
    } }
    failStorage(error: unknown) { this.state.storageError = `Storage fault: ${String(error)}`; try {
        this.store.writeState(this.state);
    }
    catch { /* expose in-memory fault */ } }
    heartbeat() { if (this.state.storageError)
        return; try {
        this.persist();
    }
    catch { /* exposed in status; no more requests */ } }
    refresh(sources?: SourceId[], manual = true): RefreshResult[] {
        const selected = sources ?? this.collectors.map(c=>c.source);
        return selected.map(source => {
            const c=this.collectors.find(c=>c.source===source);
            if(!c)return {source,status:'unavailable',reason:'source is disabled'};
            const s = this.state.sources[c.source] ?? (this.state.sources[c.source] = { failures: 0 });
            if (this.stopped || this.state.storageError)
                return { source: c.source, status: 'unavailable', reason: this.state.storageError ?? 'service stopping' };
            if (this.running.has(c.source))
                return { source: c.source, status: 'coalesced', requestId: s.requestId };
            if (s.needsAuthentication && !manual)
                return { source: c.source, status: 'deferred', reason: 'authentication required' };
            if (!s.needsAuthentication && s.nextAllowedAt && Date.parse(s.nextAllowedAt) > this.now())
                return { source: c.source, status: 'deferred', nextAllowedAt: s.nextAllowedAt };
            s.requestId = randomUUID();
            s.lastAttemptAt = new Date(this.now()).toISOString();
            s.needsAuthentication = false;
            // Fail closed even if killed before receiving or persisting a response.
            s.nextAllowedAt = new Date(this.now() + Math.max(this.interval(c.source), this.options.timeoutMs ?? 90000, c.source === 'claude-code' ? 3600000 : 0)).toISOString();
            try {
                this.persist();
            }
            catch {
                return { source: c.source, status: 'unavailable', reason: this.state.storageError };
            }
            const p = this.collect(c, s);
            this.running.set(c.source, p);
            void p.finally(() => this.running.delete(c.source));
            return { source: c.source, status: 'accepted', requestId: s.requestId };
        });
    }
    private interval(source: SourceId) { return this.options.intervals?.[source] ?? this.options.intervalMs ?? 300000; }
    tick() { return this.refresh(undefined, false); }
    async idle() { await Promise.all(this.running.values()); }
    async stop() { this.stopped = true; this.controllers.forEach(c => c.abort()); await this.idle(); }
    private async collect(c: Collector, s: SourceState) {
        const controller = new AbortController();
        this.controllers.set(c.source, controller);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs ?? 90000);
        try {
            let snap: QuotaSnapshot;
            try {
                snap = await c.collect({ ...this.ctx, signal: controller.signal });
            }
            catch (e) {
                snap = { source: c.source, collectedAt: new Date(this.now()).toISOString(), error: String(e) };
            }
            if (timedOut) {
                snap = { source: c.source, collectedAt: new Date(this.now()).toISOString(), error: 'Collection timed out', collectionError: { kind: 'timeout', message: 'Collection timed out' } };
            }
            // observedAt is completion time, not cache access or request start time.
            snap.collectedAt = new Date(this.now()).toISOString();
            const observation = normalizeSnapshot(snap);
            if (observation.error) {
                const err = observation.error ?? classifyError(snap.error!);
                s.error = err;
                s.failures++;
                s.needsAuthentication = err.kind === 'authentication' || err.kind === 'unsupported';
                const backoff = Math.min(3600000, this.interval(c.source) * 2 ** Math.min(s.failures - 1, 8));
                const retry = err.retryAt ? Date.parse(err.retryAt) : NaN;
                s.nextAllowedAt = new Date(Math.max(this.now() + backoff * (1 + (this.options.random ?? Math.random)() * 0.1), Number.isFinite(retry) ? retry : 0)).toISOString();
            }
            else {
                s.failures = 0;
                s.error = undefined;
                s.needsAuthentication = false;
                s.lastSuccessAt = observation.observedAt;
                s.latest = observation;
                s.nextAllowedAt = new Date(this.now() + this.interval(c.source)).toISOString();
            }
            // Persist rate-limit result BEFORE optional history I/O.
            this.persist();
            this.store.append(observation, snap.raw);
            this.persist();
        }
        catch (e) {
            this.state.storageError = `Storage fault: ${String(e)}`;
            try {
                this.store.writeState(this.state);
            }
            catch { /* retain in-memory fault; preflight deadline remains on disk */ }
        }
        finally {
            clearTimeout(timer);
            this.controllers.delete(c.source);
        }
    }
}
