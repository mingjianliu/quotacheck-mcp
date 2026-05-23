import { homedir } from "node:os";
import { loadConfig } from "../src/config.js";
import { runCollectors } from "../src/collect.js";
import type { Collector, CollectorContext } from "../src/types.js";
import { claudeCodeCollector } from "../src/collectors/claude-code.js";
import { geminiCliCollector } from "../src/collectors/gemini-cli.js";
import { antigravityCollector } from "../src/collectors/antigravity.js";
import { geminiWebCollector } from "../src/collectors/gemini-web.js";

const ALL: Collector[] = [
  claudeCodeCollector,
  geminiCliCollector,
  antigravityCollector,
  geminiWebCollector,
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
  for (const s of snaps) {
    console.log(`\n[${s.source}] ${s.error ? `ERROR: ${s.error}` : "ok"}`);
    if (s.session)
      console.log(
        `  session: ${s.session.used}/${s.session.limit} (${s.session.pct.toFixed(1)}%)`,
      );
    if (s.weekly)
      console.log(
        `  weekly:  ${s.weekly.used}/${s.weekly.limit} (${s.weekly.pct.toFixed(1)}%)`,
      );
    for (const m of s.subModels ?? []) {
      console.log(`  ${m.name}: ${m.used}/${m.limit} (${m.pct.toFixed(1)}%)`);
    }
  }
})();
