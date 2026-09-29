import { z } from 'zod';
import { loadConfig } from './config.js';
import { ALL_COLLECTORS } from './collectors/index.js';
import { Coordinator } from './coordinator.js';
import { ObservationStore } from './store.js';
import { startIpc } from './ipc.js';
import { ALL_SOURCES, type SourceId } from './types.js';
const Request = z.object({ command: z.enum(['ping', 'refresh', 'status']), sources: z.array(z.enum(ALL_SOURCES as [
        SourceId,
        ...SourceId[]
    ])).optional() }).strict();
export async function startDaemon(home: string) {
    const cfg = loadConfig({ homeDir: home });
    const store = new ObservationStore(home, { historyEnabled: cfg.historyEnabled, rawEnabled: cfg.rawEnabled, retentionDays: cfg.historyRetentionDays, rawRetentionDays: cfg.rawRetentionDays });
    // Bind before reading mutable scheduling state; a second service cannot own it.
    let coordinator: Coordinator | undefined;
    const ipc = await startIpc(home, raw => { const request = Request.parse(raw); if (request.command === 'ping')
        return { status: 'running' }; if (!coordinator)
        throw Error('service starting'); if(request.command==='status') {
        const state=coordinator.status();
        return {...state,sources:Object.fromEntries(Object.entries(state.sources).map(([key,value])=>{const {latest,...summary}=value;return [key,{...summary,lastObservationId:latest?.observationId}];}))};
    }
    return {results:coordinator.refresh(request.sources,true)}; });
    try {
        coordinator = new Coordinator(ALL_COLLECTORS.filter(c => cfg.enabledSources.includes(c.source)), { ...cfg, homeDir: home }, store, { intervalMs: cfg.collectionIntervalMs, intervals: cfg.collectionIntervals, timeoutMs: cfg.collectorTimeoutMs });
        await store.maintain();
        coordinator.heartbeat();
        coordinator.tick();
        const timer = setInterval(() => { coordinator!.heartbeat(); coordinator!.tick(); }, 5000);
        let maintenanceWork: Promise<void> | undefined;
        const maintenance = setInterval(() => { if (maintenanceWork)
            return; maintenanceWork = store.maintain().catch(e => { coordinator!.failStorage(e); console.error('history maintenance failed:', String(e)); }).finally(() => { maintenanceWork = undefined; }); }, 3600000);
        return { close: async () => { clearInterval(timer); clearInterval(maintenance); await coordinator!.stop(); await maintenanceWork; await ipc.close(); } };
    }
    catch (e) {
        await ipc.close();
        throw e;
    }
}
