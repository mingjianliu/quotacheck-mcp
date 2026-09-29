#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { homedir } from 'node:os';
import { callTool, TOOL_DEFINITIONS } from './tools.js';
async function main() {
    const home = process.env.QUOTACHECK_HOME ?? homedir();
    const server = new Server({ name: 'quotacheck-mcp', version: '0.2.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => { try {
        return await callTool(home, req.params.name, req.params.arguments ?? {});
    }
    catch (e) {
        return { isError: true, content: [{ type: 'text', text: String(e) }] };
    } });
    await server.connect(new StdioServerTransport());
}
main().catch(e => { console.error(e); process.exitCode = 1; });
