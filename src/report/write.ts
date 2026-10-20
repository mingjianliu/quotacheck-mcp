import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readHistory } from '../history.js';
import { privateDirectory } from '../store.js';
import type { SourceId } from '../types.js';
import { buildReport, type ReportData } from './aggregate.js';
import { renderReport } from './render.js';
/** Render history to an HTML file readable only by its owner; shared by `quotacheck report` and `npm run report`. */
export function writeReport(home: string, opts: { days: number; sources?: SourceId[]; out?: string; maxPoints?: number; now?: Date }): { path: string; data: ReportData; snapshots: number } {
    const until = opts.now ?? new Date(), since = new Date(until.getTime() - opts.days * 86400000);
    const snapshots = readHistory(home, { since, until, sources: opts.sources });
    const data = buildReport(snapshots, { since, until, days: opts.days, maxPoints: opts.maxPoints, generatedAt: until });
    let path: string;
    if (opts.out) {
        path = resolve(opts.out);
        mkdirSync(dirname(path), { recursive: true });
    }
    else {
        const dir = join(home, '.config', 'quotacheck-mcp', 'reports');
        privateDirectory(dir);
        path = join(dir, `quota-${opts.days}d.html`);
    }
    // `mode` only applies when the file is created; an older report may be wider.
    writeFileSync(path, renderReport(data), { mode: 0o600 });
    chmodSync(path, 0o600);
    return { path, data, snapshots: snapshots.length };
}
