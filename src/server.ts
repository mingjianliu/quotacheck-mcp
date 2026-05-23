#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { runCollectors } from "./collect.js";
import {
  ALL_SOURCES,
  type Collector,
  type CollectorContext,
  type SourceId,
} from "./types.js";
import { claudeCodeCollector } from "./collectors/claude-code.js";
import { geminiCliCollector } from "./collectors/gemini-cli.js";
import { antigravityCollector } from "./collectors/antigravity.js";
import { geminiWebCollector } from "./collectors/gemini-web.js";
import { claudeDesignCollector } from "./collectors/claude-design.js";

const ALL_COLLECTORS: Collector[] = [
  claudeCodeCollector,
  geminiCliCollector,
  antigravityCollector,
  geminiWebCollector,
  claudeDesignCollector,
];

const ToolInput = z.object({
  sources: z.array(z.enum(ALL_SOURCES as [SourceId, ...SourceId[]])).optional(),
});

async function main() {
  const cfg = loadConfig();
  const ctx: CollectorContext = {
    chromeProfilePath: cfg.chromeProfilePath,
    chromeExecutablePath: cfg.chromeExecutablePath,
    playwrightTimeoutMs: cfg.playwrightTimeoutMs,
    antigravityUsageBinary: cfg.antigravityUsageBinary,
    homeDir: homedir(),
  };
  const enabled = ALL_COLLECTORS.filter((c) =>
    cfg.enabledSources.includes(c.source),
  );

  const server = new Server(
    { name: "quotacheck-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_all_quotas",
        description: "Return a current quota snapshot for each enabled source.",
        inputSchema: {
          type: "object",
          properties: {
            sources: {
              type: "array",
              items: { type: "string", enum: ALL_SOURCES },
              description: "Optional subset of sources. Omit for all enabled.",
            },
          },
        },
      },
      {
        name: "refresh",
        description:
          "Force re-collection (identical to get_all_quotas; reserved verb for future caching).",
        inputSchema: {
          type: "object",
          properties: {
            sources: {
              type: "array",
              items: { type: "string", enum: ALL_SOURCES },
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (name !== "get_all_quotas" && name !== "refresh") {
      throw new Error(`unknown tool: ${name}`);
    }
    const args = ToolInput.parse(req.params.arguments ?? {});
    const snapshots = await runCollectors(enabled, ctx, {
      sources: args.sources,
      forceRefresh: name === "refresh",
    });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshots, null, 2) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
