import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
