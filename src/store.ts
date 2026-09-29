import { appendFileSync, chmodSync, closeSync, createReadStream, createWriteStream, fstatSync, readSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { normalizeSnapshot, redact, stableHash, type Observation } from './observation.js';
import { readLegacyHistory } from './history.js';
const DAY = 86400000;
export function dataDirectory(home: string): string { return join(home, '.config', 'quotacheck-mcp'); }
export function privateDirectory(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
export function atomicJson(path: string, value: unknown): void {
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify(redact(value)), { mode: 0o600 });
        const fd = openSync(tmp, 'r');
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmp, path);
    }
    finally {
        if (existsSync(tmp))
            unlinkSync(tmp);
    }
}
function files(dir: string): string[] { try {
    return readdirSync(dir).sort();
}
catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return [];
    throw e;
} }
function contents(path: string) { const b = readFileSync(path); return path.endsWith('.gz') ? gunzipSync(b).toString('utf8') : b.toString('utf8'); }
function append(path: string, value: unknown) {
    // Separate a crashed partial line from the next valid record, retaining it for diagnostics.
    if (existsSync(path)) {
        const fd = openSync(path, 'r');
        try {
            const size = fstatSync(fd).size;
            const last = Buffer.alloc(1);
            if (size) {
                readSync(fd, last, 0, 1, size - 1);
                if (last[0] !== 10)
                    appendFileSync(path, '\n');
            }
        }
        finally {
            closeSync(fd);
        }
    }
    appendFileSync(path, JSON.stringify(redact(value)) + '\n', { mode: 0o600 });
    const fd = openSync(path, 'r');
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
export class ObservationStore {
    readonly directory: string;
    constructor(readonly home: string, readonly options: {
        rawEnabled?: boolean;
        historyEnabled?: boolean;
        retentionDays?: number;
        rawRetentionDays?: number;
    } = {}) { this.directory = dataDirectory(home); }
    ensure() { privateDirectory(this.directory); }
    readState<T = Record<string, unknown>>(): T | undefined { const p = join(this.directory, 'state.json'); if (!existsSync(p))
        return undefined; return JSON.parse(readFileSync(p, 'utf8')) as T; }
    writeState(value: unknown) { this.ensure(); atomicJson(join(this.directory, 'state.json'), value); }
    append(observation: Observation, raw?: unknown) {
        if (this.options.historyEnabled === false) {
            observation.rawStatus = 'disabled';
            return;
        }
        this.ensure();
        const sequencePath = join(this.directory, 'sequence.json');
        const previous = existsSync(sequencePath) ? JSON.parse(readFileSync(sequencePath, 'utf8')) : 0;
        if (!Number.isSafeInteger(previous) || previous < 0)
            throw Error('corrupt observation sequence');
        observation.sequence = previous + 1;
        atomicJson(sequencePath, observation.sequence);
        const day = observation.observedAt.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
            throw new Error('invalid observation day');
        const dir = join(this.directory, 'observations');
        privateDirectory(dir);
        if (this.options.rawEnabled !== false && raw !== undefined) {
            const rdir = join(this.directory, 'raw');
            privateDirectory(rdir);
            append(join(rdir, `${day}.jsonl`), { id: observation.observationId, data: redact(raw), policyVersion: 1 });
            observation.rawRef = { day, id: observation.observationId, policyVersion: 1 };
        }
        else
            observation.rawStatus = this.options.rawEnabled === false ? 'disabled' : 'unavailable';
        append(join(dir, `${day}.jsonl`), observation);
    }
    readNew(from: string, to: string) {
        const observations: Observation[] = [];
        let corruptLines = 0;
        for (const f of files(join(this.directory, 'observations'))) {
            if (!/^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f))
                continue;
            const day = Date.parse(f.slice(0, 10));
            if (day >= Date.parse(to) || day + DAY <= Date.parse(from))
                continue;
            let text: string;
            try {
                text = contents(join(this.directory, 'observations', f));
            }
            catch {
                corruptLines++;
                continue;
            }
            for (const line of text.split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    const o = JSON.parse(line) as Observation;
                    if (o.schemaVersion !== 1 || !Array.isArray(o.limits) || typeof o.observationId !== 'string' || !Number.isFinite(Date.parse(o.observedAt)))
                        throw Error('invalid observation');
                    if (Date.parse(o.observedAt) >= Date.parse(from) && Date.parse(o.observedAt) < Date.parse(to))
                        observations.push(o);
                }
                catch {
                    corruptLines++;
                }
            }
        }
        return { observations, corruptLines };
    }
    read(from: string, to: string) {
        const result = this.readNew(from, to);
        const legacy = readLegacyHistory(this.home, { since: new Date(from), until: new Date(Date.parse(to) - 1) });
        legacy.forEach((s, i) => { const o = normalizeSnapshot(s); o.observationId = `legacy:${stableHash(s)}:${i}`; o.rawStatus = 'unavailable'; result.observations.push(o); });
        result.observations.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.observationId.localeCompare(b.observationId));
        return result;
    }
    readRaw(o: Observation): {
        status: string;
        data?: unknown;
        exportCommand?: string;
    } {
        if (!o.rawRef)
            return { status: o.rawStatus ?? 'unavailable' };
        const { day, id } = o.rawRef;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
            return { status: 'unavailable' };
        for (const ext of ['.jsonl', '.jsonl.gz']) {
            const p = join(this.directory, 'raw', day + ext);
            if (!existsSync(p))
                continue;
            for (const line of contents(p).split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    const r = JSON.parse(line);
                    if (r.id === id)
                        return { status: 'available', data: r.data };
                }
                catch { /* damaged raw line */ }
            }
        }
        return { status: 'expired' };
    }
    async maintain(now = new Date(), retention: {
        retentionDays?: number;
        rawRetentionDays?: number;
    } = {}) {
        for (const [name, days] of [['observations', retention.retentionDays ?? this.options.retentionDays ?? 90], ['raw', retention.rawRetentionDays ?? this.options.rawRetentionDays ?? 30]] as const) {
            const dir = join(this.directory, name);
            for (const f of files(dir)) {
                if (!/^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f))
                    continue;
                const path = join(dir, f), day = Date.parse(f.slice(0, 10));
                if (day + DAY <= now.getTime() - days * DAY) {
                    unlinkSync(path);
                    continue;
                }
                if (f.endsWith('.jsonl') && day + DAY <= Date.parse(now.toISOString().slice(0, 10))) {
                    // If a backdated sample reopened a compressed shard, retain both sets.
                    const zipped = path + '.gz', temp = zipped + '.tmp';
                    try {
                        // Concatenated gzip members preserve any earlier backdated shard without inflating it.
                        if (existsSync(zipped))
                            await pipeline(createReadStream(zipped), createWriteStream(temp, { mode: 0o600 }));
                        await pipeline(createReadStream(path), createGzip(), createWriteStream(temp, { mode: 0o600, flags: existsSync(zipped) ? 'a' : 'w' }));
                        const fd = openSync(temp, 'r');
                        try {
                            fsyncSync(fd);
                        }
                        finally {
                            closeSync(fd);
                        }
                        renameSync(temp, zipped);
                        unlinkSync(path);
                    }
                    finally {
                        if (existsSync(temp))
                            unlinkSync(temp);
                    }
                }
            }
        }
    }
}
