import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDaemon } from '../../src/daemon.js';
import { ObservationStore } from '../../src/store.js';
import { normalizeSnapshot } from '../../src/observation.js';
import { parseClaudeUsage } from '../../src/claude-usage.js';
const exec = promisify(execFile);
it('runs real CLI queries, rejects duplicate service, and reports new daily observations', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qrt-'));
  const store = new ObservationStore(home);
  store.ensure();
  writeFileSync(join(store.directory, 'config.json'), JSON.stringify({ enabledSources: [] }));
  store.append(normalizeSnapshot(parseClaudeUsage({limits:[{kind:'weekly_scoped',percent:92,scope:{model:{id:'fable',display_name:'Fable'}},resets_at:new Date(Date.now()+86400000).toISOString()}]},new Date().toISOString())));
  const service = await startDaemon(home);
  const cli = (...args: string[]) => exec(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts', ...args, '--home', home], { timeout: 15000 });
  try {
    expect(JSON.parse((await cli('status')).stdout).daemon).toBe('running');
    expect(JSON.parse((await cli('history','--from',new Date(Date.now()-86400000).toISOString(),'--to',new Date(Date.now()+1000).toISOString())).stdout).records).toHaveLength(1);
    await expect(startDaemon(home)).rejects.toThrow(/already running/);
    const report = (await cli('report', '--days', '2')).stdout.trim();
    expect(readFileSync(report, 'utf8')).toContain('Fable');
    await service.close();
    expect(JSON.parse((await cli('status')).stdout).daemon).toBe('offline');
  } finally {
    // close() is idempotent at this call site: close only if first close was skipped.
    try { await service.close(); } catch { /* already closed */ }
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);
