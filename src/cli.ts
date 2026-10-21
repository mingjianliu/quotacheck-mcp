#!/usr/bin/env node
import { loadConfig } from './config.js';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { parseCli } from './cli-args.js';
import { callTool, refreshSources } from './tools.js';
import { FilterSchema, getLegacyQuotas } from './query.js';
import { ObservationStore } from './store.js';
import { writeReport } from './report/write.js';
async function main() {
    const { command, input, home: given, id } = parseCli(process.argv.slice(2));
    const home = given ?? process.env.QUOTACHECK_HOME ?? homedir();
    if (command === 'help' || command === '--help') {
        console.log('quotacheck <quotas|history|status|refresh|legacy|panel|daemon|install-service|report|export|login> [--home PATH]\n  history --from ISO --to ISO [--granularity raw|5m|30m|1h|1d] [--page-size N] [--cursor TOKEN] [--include-raw]\n  quotas/history: --sources ID,... --account-keys KEY,... --limit-ids ID,...\n  report [--days N] [--sources ID,...] [--out FILE] [--max-points N]; export OBSERVATION_ID (redacted raw JSON); login SOURCE (gemini-web)');
        return;
    }
    if (command === 'daemon') {
        const { startDaemon } = await import('./daemon.js');
        const service = await startDaemon(home);
        console.error('Quota service running');
        let stopping = false;
        const close = () => { if (stopping)
            return; stopping = true; void service.close().then(() => { process.exitCode = 0; }, e => { console.error(e); process.exitCode = 1; }); };
        process.on('SIGINT', close);
        process.on('SIGTERM', close);
        return;
    }
    if (command === 'login') {
        const { login } = await import('./login.js');
        await login(id, home);
        return;
    }
    if (command === 'install-service') {
        const { installService } = await import('./service-install.js');
        const current=fileURLToPath(import.meta.url);
        const cli=current.endsWith('.ts')?join(dirname(current),'..','dist','cli.js'):current;
        if(!existsSync(cli))throw Error('Run npm run build before installing the service');
        console.log(installService(home, process.execPath, cli));
        return;
    }
    if (command === 'panel') {
        const { getPanel } = await import('./panel.js');
        console.log(JSON.stringify(getPanel(home)));
        return;
    }
    if (command === 'legacy') {
        if (input.refresh)
            await refreshSources(home);
        console.log(JSON.stringify(getLegacyQuotas(home, input.sources as never)));
        return;
    }
    if (command === 'report') {
        const sources = input.sources === undefined ? undefined : FilterSchema.pick({ sources: true }).parse({ sources: input.sources }).sources;
        const { path } = writeReport(home, { days: Number(input.days ?? 30), sources, out: input.out as string | undefined, maxPoints: input.maxPoints as number | undefined });
        console.log(path);
        return;
    }
    if (command === 'export') {
        if (!id)
            throw Error('export requires an observation ID');
        const store = new ObservationStore(home);
        const o = store.read('1970-01-01T00:00:00Z', '9999-01-01T00:00:00Z').observations.find(o => o.observationId === id);
        if (!o)
            throw Error('Observation not found or expired');
        const cfg = loadConfig({ homeDir: home });
        console.log(JSON.stringify(Date.parse(o.observedAt) < Date.now() - cfg.rawRetentionDays * 86400000 ? { status: 'expired' } : store.readRaw(o)));
        return;
    }
    const tools: Record<string, string> = { quotas: 'get_quotas', history: 'get_history', status: 'get_status', refresh: 'refresh' };
    if (!tools[command])
        throw Error(`Unknown command: ${command}`);
    const result = await callTool(home, tools[command], input);
    result.content.forEach(c => console.log(c.text));
}
main().catch(e => { console.error(String(e)); process.exitCode = 1; });
