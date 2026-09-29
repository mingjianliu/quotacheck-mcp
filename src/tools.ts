import { ALL_SOURCES, type SourceId } from './types.js';
import { FilterSchema, getHistory, getLegacyQuotas, getQuotas, getStatus } from './query.js';
import { getUsageHistory } from './report/usage-tool.js';
import { requestIpc } from './ipc.js';
import { loadConfig } from './config.js';
const sources = { type: 'array', items: { type: 'string', enum: ALL_SOURCES } };
const filters = { sources, accountKeys: { type: 'array', items: { type: 'string' } }, limitIds: { type: 'array', items: { type: 'string' } } };
export const TOOL_DEFINITIONS = [
    { name: 'get_quotas', description: 'Read current quota observations with units, scopes, provenance, freshness and errors. Never calls remote providers.', inputSchema: { type: 'object', properties: filters, additionalProperties: false } },
    { name: 'get_history', description: 'Read quota observations over a UTC half-open interval [from,to). Raw samples or aggregates, pagination, coverage and gaps; no interpolation. includeRaw returns redacted source data.', inputSchema: { type: 'object', properties: { ...filters, from: { type: 'string' }, to: { type: 'string' }, granularity: { type: 'string', enum: ['raw', '5m', '30m', '1h', '1d'], default: 'raw' }, pageSize: { type: 'integer', minimum: 1, maximum: 1000 }, cursor: { type: 'string' }, includeRaw: { type: 'boolean' } }, required: ['from', 'to'], additionalProperties: false } },
    { name: 'get_status', description: 'Read collector availability, errors, cooldown, retention and local daemon status.', inputSchema: { type: 'object', properties: { sources }, additionalProperties: false } },
    { name: 'refresh', description: 'Ask the local quota service to collect. Asynchronous; coalesces requests and obeys persisted cooldown. Returns accepted, coalesced, deferred or unavailable.', inputSchema: { type: 'object', properties: { sources }, additionalProperties: false } },
    { name: 'get_all_quotas', description: 'Legacy snapshot view. Reads persisted data only; use get_quotas for complete fields and provenance.', inputSchema: { type: 'object', properties: { sources }, additionalProperties: false } },
    { name: 'get_usage_history', description: 'Legacy seven-day quota charts and JSON from history. Display the plain-text chart verbatim.', inputSchema: { type: 'object', properties: { sources }, additionalProperties: false } },
];
export async function refreshSources(home: string, sources?: SourceId[]) {
    const selected = sources ?? loadConfig({ homeDir: home }).enabledSources;
    try {
        return await requestIpc(home, { command: 'refresh', sources: selected });
    }
    catch (e) {
        return { results: selected.map(source => ({ source, status: 'unavailable', reason: `Local quota service unavailable: ${String(e)}. Run quotacheck daemon or install-service.` })) };
    }
}
export async function callTool(home: string, name: string, input: unknown = {}) {
    let result: unknown;
    if (name === 'get_quotas')
        result = getQuotas(home, input);
    else if (name === 'get_history')
        result = getHistory(home, input);
    else {
        const args = FilterSchema.pick({ sources: true }).parse(input);
        if (name === 'refresh')
            result = await refreshSources(home, args.sources);
        else if (name === 'get_status') {
            const status = getStatus(home, args.sources);
            try {
                const live = await requestIpc(home, { command: 'status' }) as {
                    storageError?: string;
                };
                result = { ...status, daemon: 'running', storageError: live.storageError ?? status.storageError };
            }
            catch {
                result = { ...status, daemon: 'offline' };
            }
        }
        else if (name === 'get_all_quotas')
            result = getLegacyQuotas(home, args.sources);
        else if (name === 'get_usage_history') {
            const { text, history } = getUsageHistory(home, args);
            return { content: [{ type: 'text' as const, text }, { type: 'text' as const, text: JSON.stringify(history) }] };
        }
        else
            throw Error(`unknown tool: ${name}`);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}
