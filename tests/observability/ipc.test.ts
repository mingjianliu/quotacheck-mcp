import { it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startIpc, requestIpc } from '../../src/ipc.js';
it('serves concurrent local requests and rejects a second daemon', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qi-'));
    const server = await startIpc(home, request => ({ ok: true, request }));
    try {
        const replies = await Promise.all([1, 2, 3].map(n => requestIpc(home, { n })));
        expect(replies).toEqual([1, 2, 3].map(n => ({ ok: true, request: { n } })));
        await expect(startIpc(home, () => null)).rejects.toThrow(/already|running/i);
    }
    finally {
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
});
it('recovers a start lock left behind by a crashed starter', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qi-'));
    const dir = join(home, '.config', 'quotacheck-mcp');
    mkdirSync(dir, { recursive: true });
    // PIDs are bounded well below this on every supported platform, so it is never alive.
    writeFileSync(join(dir, 'service-start.lock'), '2147483646');
    const server = await startIpc(home, () => ({ ok: true }));
    try {
        expect(await requestIpc(home, {})).toEqual({ ok: true });
    }
    finally {
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
});
it('respects a start lock held by a live process', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qi-'));
    const dir = join(home, '.config', 'quotacheck-mcp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'service-start.lock'), String(process.pid));
    try {
        await expect(startIpc(home, () => null)).rejects.toThrow(/already starting/);
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
