import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as zlib from 'node:zlib';
import { atomicJson, dataDirectory, privateDirectory } from './store.js';

/**
 * Token usage over the last day, read from the logs the agents already keep
 * on this machine: Claude Code transcripts and Codex rollouts. Nothing is
 * sent anywhere; only counts and session titles are cached, never messages.
 *
 * Counting follows Agent HUD (jazzenchen/agent-hud-open, Apache-2.0), whose
 * providers.md documents both formats:
 * - Claude: one event per `message.id` (fallback `requestId`); a main log
 *   counts only lines of its own session, since a fork's log begins with its
 *   parent's lines; sub-agent logs (`subagents/agent-*.jsonl`) count towards
 *   the session they name; `<synthetic>` messages are skipped. In = input +
 *   cache writes, Cache = cache reads, Out = output (thinking included).
 * - Codex: `token_count` carries cumulative totals, differenced line by line
 *   (`last_token_usage` after a reset); cached input is part of input; lines
 *   before the session's own start are inherited fork history and only set
 *   the baseline.
 *
 * Logs only grow, so each file is read from where the last pass stopped; the
 * cache keeps that offset and the day's events.
 */
export type TokenSource = 'claude-code' | 'codex';

export interface TokenEvent {
    t: number;
    source: TokenSource;
    model: string;
    session: string;
    input: number;
    output: number;
    cacheRead: number;
}

interface FileState {
    size: number;
    mtimeMs: number;
    offset: number;
    source: TokenSource;
    events: TokenEvent[];
    /** Claude: message ids already counted in this file. */
    seen?: string[];
    session?: string;
    /** A sub-agent log: its tokens count towards the session it names, its lines name nothing. */
    sub?: boolean;
    title?: string;
    /** The title was given (`/rename`, desktop app), so a generated one does not replace it. */
    named?: boolean;
    prompt?: string;
    project?: string;
    lastAt?: number;
    /** Codex running totals and context. */
    totals?: { input: number; output: number; cached: number };
    startedAt?: number;
    model?: string;
}

interface Cache { version: 1; files: Record<string, FileState> }

export interface TokenSession {
    source: TokenSource;
    id: string;
    title: string;
    project?: string;
    lastAt: string;
    total: number;
    model?: string;
}

export interface TokenStats {
    since: string;
    bucketMs: number;
    /** Tokens per bucket, oldest first, per source. */
    buckets: Partial<Record<TokenSource, number[]>>;
    totals: Partial<Record<TokenSource, { input: number; output: number; cacheRead: number; total: number }>>;
    models: { source: TokenSource; model: string; total: number }[];
    sessions: TokenSession[];
}

const DAY = 86400000;
export const BUCKET_MS = 15 * 60000;
const CACHE_FILE = 'tokens-cache.json';
const MAX_READ = 64 * 1024 * 1024;

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const firstLine = (s: string) => s.trim().split('\n')[0].trim().slice(0, 60);

function list(dir: string, depth: number, match: (name: string, path: string) => boolean, since: number, out: string[] = []): string[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    }
    catch {
        return out;
    }
    for (const name of names) {
        const path = join(dir, name);
        let st;
        try {
            st = statSync(path);
        }
        catch {
            continue;
        }
        if (st.isDirectory()) {
            if (depth > 0) list(path, depth - 1, match, since, out);
        }
        else if (match(name, path) && st.mtimeMs >= since) out.push(path);
    }
    return out;
}

/** Claude transcripts touched since `since`; a log copied to several project folders is read from its newest copy. */
export function claudeLogs(home: string, since: number, env: NodeJS.ProcessEnv = process.env): string[] {
    const roots = [...new Set([env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, 'projects') : '', join(home, '.claude', 'projects'), join(home, '.config', 'claude', 'projects')].filter(Boolean))];
    const files = roots.flatMap(root => list(root, 3, name => name.endsWith('.jsonl'), since));
    const newest = new Map<string, string>();
    const subagents: string[] = [];
    for (const f of files) {
        if (f.includes(`${'/'}subagents${'/'}`) || basename(f).startsWith('agent-')) {
            subagents.push(f);
            continue;
        }
        const key = basename(f);
        const prev = newest.get(key);
        if (!prev || statSync(f).mtimeMs > statSync(prev).mtimeMs) newest.set(key, f);
    }
    return [...newest.values(), ...subagents];
}

export function codexLogs(home: string, since: number, env: NodeJS.ProcessEnv = process.env): string[] {
    const root = env.CODEX_HOME?.trim() || join(home, '.codex');
    const match = (name: string) => name.startsWith('rollout-') && (name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'));
    return [...list(join(root, 'sessions'), 4, match, since), ...list(join(root, 'archived_sessions'), 4, match, since)];
}

function promptText(content: unknown): string | undefined {
    const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.map(c => c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : '').join('') : '';
    // Command wrappers, hook output and tool results are not prompts.
    return text.trim() && !text.trimStart().startsWith('<') ? firstLine(text) : undefined;
}

function claudeLine(state: FileState, d: Record<string, any>, sub: boolean, fileSession: string): void {
    const session = typeof d.sessionId === 'string' ? d.sessionId : undefined;
    if (!sub && session !== undefined && session !== fileSession) return;
    if (sub) {
        if (session) state.session = session;
    }
    else {
        if (d.type === 'custom-title' && typeof d.customTitle === 'string') { state.title = d.customTitle; state.named = true; }
        else if (d.type === 'ai-title' && typeof d.aiTitle === 'string' && !state.named) state.title = d.aiTitle;
        if (typeof d.cwd === 'string' && d.cwd) state.project = basename(d.cwd);
        if (d.type === 'user' && !d.isSidechain && !state.prompt) state.prompt = promptText(d.message?.content);
    }
    if (d.type !== 'assistant') return;
    const m = d.message ?? {};
    const id = typeof m.id === 'string' ? m.id : typeof d.requestId === 'string' ? d.requestId : undefined;
    const u = m.usage;
    const t = Date.parse(d.timestamp);
    if (!id || !u || m.model === '<synthetic>' || !Number.isFinite(t)) return;
    const seen = state.seen ?? (state.seen = []);
    if (seen.includes(id)) return;
    seen.push(id);
    state.lastAt = Math.max(state.lastAt ?? 0, t);
    state.events.push({ t, source: 'claude-code', model: typeof m.model === 'string' ? m.model : 'unknown', session: session ?? fileSession,
        input: num(u.input_tokens) + num(u.cache_creation_input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens) });
}

function codexLine(state: FileState, d: Record<string, any>, fileSession: string): void {
    const p = d.payload ?? {};
    const t = Date.parse(d.timestamp);
    if (d.type === 'session_meta') {
        if (typeof p.id === 'string') state.session = p.id;
        const start = Date.parse(p.timestamp);
        if (Number.isFinite(start)) state.startedAt = start;
        if (typeof p.cwd === 'string' && p.cwd) state.project = basename(p.cwd);
        return;
    }
    if (d.type === 'turn_context') {
        if (typeof p.model === 'string') state.model = p.model;
        return;
    }
    if (d.type !== 'event_msg') return;
    const inherited = Number.isFinite(t) && state.startedAt !== undefined && t < state.startedAt;
    if (p.type === 'user_message' && !inherited && !state.prompt && typeof p.message === 'string') state.prompt = promptText(p.message);
    if (p.type !== 'token_count') return;
    const totals = p.info?.total_token_usage;
    if (!totals || typeof totals.input_tokens !== 'number' || typeof totals.output_tokens !== 'number') return;
    const cur = { input: totals.input_tokens, output: totals.output_tokens, cached: num(totals.cached_input_tokens) };
    const prev = state.totals;
    const last = p.info?.last_token_usage ?? {};
    const reset = !prev || cur.input < prev.input || cur.output < prev.output || cur.cached < prev.cached;
    const input = reset ? (prev ? num(last.input_tokens) : cur.input) : cur.input - prev.input;
    const cached = reset ? (prev ? num(last.cached_input_tokens) : cur.cached) : cur.cached - prev.cached;
    const output = reset ? (prev ? num(last.output_tokens) : cur.output) : cur.output - prev.output;
    state.totals = cur;
    if (inherited || !Number.isFinite(t) || (input <= 0 && output <= 0)) return;
    state.lastAt = Math.max(state.lastAt ?? 0, t);
    state.events.push({ t, source: 'codex', model: state.model ?? 'unknown', session: state.session ?? fileSession,
        input: Math.max(0, input - cached), output: Math.max(0, output), cacheRead: Math.max(0, cached) });
}

function readText(path: string, from: number, size: number): { text: string; consumed: number } {
    if (path.endsWith('.zst')) {
        const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
        if (!z.zstdDecompressSync) return { text: '', consumed: size };
        return { text: z.zstdDecompressSync(readFileSync(path)).toString('utf8') + '\n', consumed: size };
    }
    const length = Math.min(size - from, MAX_READ);
    const buf = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
        readSync(fd, buf, 0, length, from);
    }
    finally {
        closeSync(fd);
    }
    // Stop at the last complete line; a line still being written is read next time.
    const end = buf.lastIndexOf(10);
    return end < 0 ? { text: '', consumed: 0 } : { text: buf.subarray(0, end + 1).toString('utf8'), consumed: end + 1 };
}

function update(path: string, source: TokenSource, prev: FileState | undefined, cutoff: number): FileState {
    const st = statSync(path);
    const compressed = path.endsWith('.zst');
    const sub = path.includes('/subagents/') || basename(path).startsWith('agent-');
    const fileSession = basename(path).replace(/\.jsonl(\.zst)?$/, '');
    // A log that shrank, or a compressed one that changed, is read again from the start.
    const state: FileState = prev && prev.source === source && st.size >= prev.offset && !(compressed && st.size !== prev.size)
        ? prev
        : { size: 0, mtimeMs: 0, offset: 0, source, events: [], ...(sub ? { sub: true } : source === 'claude-code' ? { session: fileSession } : {}) };
    while (state.offset < st.size) {
        const { text, consumed } = readText(path, state.offset, st.size);
        if (!consumed) break;
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            let d: Record<string, any>;
            try {
                d = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (source === 'claude-code') claudeLine(state, d, sub, fileSession);
            else codexLine(state, d, fileSession);
        }
        state.offset += consumed;
    }
    state.size = st.size;
    state.mtimeMs = st.mtimeMs;
    state.events = state.events.filter(e => e.t >= cutoff);
    // Ids only matter for the lines still to come of the same messages.
    if (state.seen && state.seen.length > 2000) state.seen = state.seen.slice(-1000);
    return state;
}

/** Read the day's token usage, updating the per-file cache in the data directory. */
export function readTokenStats(home: string, opts: { now?: Date; userHome?: string; env?: NodeJS.ProcessEnv } = {}): TokenStats {
    const now = (opts.now ?? new Date()).getTime();
    const since = Math.floor((now - DAY) / BUCKET_MS) * BUCKET_MS + BUCKET_MS;
    const userHome = opts.userHome ?? home;
    const dir = dataDirectory(home), cachePath = join(dir, CACHE_FILE);
    let cache: Cache = { version: 1, files: {} };
    try {
        if (existsSync(cachePath)) {
            const read = JSON.parse(readFileSync(cachePath, 'utf8'));
            if (read?.version === 1 && read.files && typeof read.files === 'object') cache = read;
        }
    }
    catch { /* rebuilt below */ }
    const files: Record<string, FileState> = {};
    const sources: [TokenSource, string[]][] = [['claude-code', claudeLogs(userHome, since - DAY, opts.env)], ['codex', codexLogs(userHome, since - DAY, opts.env)]];
    for (const [source, paths] of sources)
        for (const path of paths) {
            try {
                files[path] = update(path, source, cache.files[path], since);
            }
            catch { /* a log that vanished or cannot be read */ }
        }
    try {
        privateDirectory(dir);
        atomicJson(cachePath, { version: 1, files });
    }
    catch { /* statistics still answer without the cache */ }

    const buckets: TokenStats['buckets'] = {};
    const totals: TokenStats['totals'] = {};
    const models = new Map<string, { source: TokenSource; model: string; total: number }>();
    const sessions = new Map<string, TokenSession & { at: number }>();
    for (const state of Object.values(files)) {
        for (const e of state.events) {
            if (e.t < since || e.t > now) continue;
            const total = e.input + e.output + e.cacheRead;
            const row = buckets[e.source] ?? (buckets[e.source] = new Array(Math.round(DAY / BUCKET_MS)).fill(0));
            row[Math.min(row.length - 1, Math.floor((e.t - since) / BUCKET_MS))] += total;
            const sum = totals[e.source] ?? (totals[e.source] = { input: 0, output: 0, cacheRead: 0, total: 0 });
            sum.input += e.input; sum.output += e.output; sum.cacheRead += e.cacheRead; sum.total += total;
            const mk = `${e.source}\u0000${e.model}`;
            const m = models.get(mk) ?? { source: e.source, model: e.model, total: 0 };
            m.total += total;
            models.set(mk, m);
            const sk = `${e.source}\u0000${e.session}`;
            const s = sessions.get(sk) ?? { source: e.source, id: e.session, title: '', lastAt: '', total: 0, at: 0 };
            s.total += total;
            if (e.t >= s.at) { s.at = e.t; s.model = e.model; }
            sessions.set(sk, s);
        }
    }
    // Titles come from the session's own log; sub-agent logs only add tokens.
    for (const state of Object.values(files)) {
        const s = !state.sub && state.session ? sessions.get(`${state.source}\u0000${state.session}`) : undefined;
        if (!s) continue;
        s.title = state.title ?? state.prompt ?? s.title;
        if (state.project) s.project = state.project;
    }
    return {
        since: new Date(since).toISOString(), bucketMs: BUCKET_MS, buckets, totals,
        models: [...models.values()].sort((a, b) => b.total - a.total),
        sessions: [...sessions.values()].sort((a, b) => b.at - a.at).slice(0, 5)
            .map(({ at, ...s }) => ({ ...s, title: s.title || s.project || s.id.slice(0, 8), lastAt: new Date(at).toISOString() })),
    };
}
