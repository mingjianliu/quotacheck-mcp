import { it, expect } from 'vitest';
import { launchdPlist } from '../../src/service-install.js';
import { parseCli } from '../../src/cli-args.js';
import { callTool } from '../../src/tools.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('renders explicit executable arguments and XML-escapes install paths', () => { const xml = launchdPlist('/tmp/a & b/node', '/tmp/q<cli>/cli.js', '/tmp/home'); expect(xml).toContain('/tmp/a &amp; b/node'); expect(xml).toContain('/tmp/q&lt;cli&gt;/cli.js'); expect(xml).toContain('<string>daemon</string>'); expect(xml).not.toContain('/Users/mingjianliu'); });
it('parses CLI inputs with strict flags and native numeric types', () => { expect(parseCli(['history', '--from', '2026-09-27T00:00:00Z', '--to', '2026-09-28T00:00:00Z', '--page-size', '10', '--include-raw'])).toMatchObject({ command: 'history', input: { pageSize: 10, includeRaw: true } }); expect(() => parseCli(['quotas', '--typo', '1'])).toThrow(); expect(() => parseCli(['history', '--page-size', 'x'])).toThrow(); });
it('legacy and new read tools work without starting collectors; offline refresh is explicit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'quota-service-'));
    try {
        const result = await callTool(home, 'get_all_quotas', { sources: ['codex'] });
        expect(JSON.parse(result.content[0].text)).toMatchObject([{ source: 'codex', error: expect.any(String) }]);
        const refresh = await callTool(home, 'refresh', { sources: ['codex'] });
        expect(JSON.parse(refresh.content[0].text)).toMatchObject({ results: [{ source: 'codex', status: 'unavailable' }] });
        await expect(callTool(home, 'get_history', { from: 'nonsense', to: 'also bad' })).rejects.toThrow();
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
});
