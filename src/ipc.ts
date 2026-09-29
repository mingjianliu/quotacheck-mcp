import { createConnection, createServer, type Socket } from 'node:net';
import { chmodSync, closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory, privateDirectory } from './store.js';
import { stableHash } from './observation.js';
export function endpoint(home: string) { return process.platform === 'win32' ? `\\\\.\\pipe\\quotacheck-${stableHash(home)}` : join(dataDirectory(home), 'service.sock'); }
export function requestIpc(home: string, request: unknown, timeout = 2000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(endpoint(home));
        let buf = '';
        const finish = (error?: Error, value?: unknown) => { socket.destroy(); error ? reject(error) : resolve(value); };
        socket.setTimeout(timeout, () => finish(Error('quota service timeout')));
        socket.on('error', e => finish(e));
        socket.on('connect', () => socket.end(JSON.stringify(request) + '\n'));
        socket.on('data', d => { buf += d; if (buf.length > 1024 * 1024)
            return finish(Error('service response too large')); const nl = buf.indexOf('\n'); if (nl >= 0) {
            try {
                const v = JSON.parse(buf.slice(0, nl));
                v.error ? finish(Error(v.error)) : finish(undefined, v);
            }
            catch (e) {
                finish(e as Error);
            }
        } });
        socket.on('end', () => { if (!buf.includes('\n'))
            finish(Error('incomplete service response')); });
    });
}
export async function startIpc(home: string, handler: (request: unknown) => unknown | Promise<unknown>) {
    const dir = dataDirectory(home);
    privateDirectory(dir);
    const guard = join(dir, 'service-start.lock');
    let lock: number;
    try {
        lock = openSync(guard, 'wx', 0o600);
    }
    catch {
        throw Error('Quota service already starting (service-start.lock exists)');
    }
    const address = endpoint(home);
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => { });
        socket.setTimeout(5000, () => socket.destroy());
        let buffer = '';
        let handled = false;
        socket.on('data', d => {
            buffer += d;
            if (buffer.length > 65536) {
                socket.destroy();
                return;
            }
            const nl = buffer.indexOf('\n');
            if (nl < 0 || handled)
                return;
            handled = true;
            Promise.resolve().then(() => handler(JSON.parse(buffer.slice(0, nl)))).then(v => socket.end(JSON.stringify(v) + '\n'), e => socket.end(JSON.stringify({ error: String(e) }) + '\n'));
        });
    });
    try {
        if (process.platform !== 'win32' && existsSync(address)) {
            let stale = false;
            try {
                await requestIpc(home, { command: 'ping' }, 500);
            }
            catch (e) {
                const code = (e as NodeJS.ErrnoException).code;
                stale = code === 'ECONNREFUSED' || code === 'ENOENT';
            }
            if (!stale)
                throw Error('Quota service already running');
            unlinkSync(address);
        }
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, () => { server.removeListener('error', reject); resolve(); }); });
        if (process.platform !== 'win32')
            chmodSync(address, 0o600);
        server.on('error', () => { });
        return { close: () => new Promise<void>((resolve, reject) => { sockets.forEach(s => s.destroy()); server.close(e => e ? reject(e) : resolve()); }) };
    }
    catch (e) {
        if (server.listening)
            server.close();
        throw e;
    }
    finally {
        closeSync(lock);
        unlinkSync(guard);
    }
}
