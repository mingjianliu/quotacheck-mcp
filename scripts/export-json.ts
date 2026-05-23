import { homedir } from "node:os";
import { loadConfig } from "../src/config.js";
import { runCollectors } from "../src/collect.js";
import type { Collector, CollectorContext } from "../src/types.js";
import { claudeCodeCollector } from "../src/collectors/claude-code.js";
import { geminiCliCollector } from "../src/collectors/gemini-cli.js";
import { antigravityCollector } from "../src/collectors/antigravity.js";
import { geminiWebCollector } from "../src/collectors/gemini-web.js";
import { claudeDesignCollector } from "../src/collectors/claude-design.js";

const ALL: Collector[] = [
  claudeCodeCollector,
  geminiCliCollector,
  antigravityCollector,
  geminiWebCollector,
  claudeDesignCollector,
];

(async () => {
  const cfg = loadConfig();
  const ctx: CollectorContext = {
    chromeProfilePath: cfg.chromeProfilePath,
    chromeExecutablePath: cfg.chromeExecutablePath,
    playwrightTimeoutMs: cfg.playwrightTimeoutMs,
    antigravityUsageBinary: cfg.antigravityUsageBinary,
    homeDir: homedir(),
  };
  const enabled = ALL.filter((c) => cfg.enabledSources.includes(c.source));
  const snaps = await runCollectors(enabled, ctx);
  console.log(JSON.stringify(snaps));
})();
