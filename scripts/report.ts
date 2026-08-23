import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { readHistory } from "../src/history.js";
import { buildReport, DEFAULT_MAX_POINTS } from "../src/report/aggregate.js";
import { renderReport } from "../src/report/render.js";
import { ALL_SOURCES, type SourceId } from "../src/types.js";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const days = Number(flag("days", "7"));
if (!Number.isFinite(days) || days <= 0) fail("--days must be a positive number");

const maxPoints = Number(flag("max-points", String(DEFAULT_MAX_POINTS)));
if (!Number.isFinite(maxPoints) || maxPoints < 3) fail("--max-points must be >= 3");

const rawSources = flag("sources");
let sources: SourceId[] | undefined;
if (rawSources) {
  const parts = rawSources.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !ALL_SOURCES.includes(p as SourceId));
  if (bad.length) fail(`unknown source(s): ${bad.join(", ")} (valid: ${ALL_SOURCES.join(", ")})`);
  sources = parts as SourceId[];
}

const home = homedir();
const cfg = loadConfig();
if (!cfg.historyEnabled) {
  console.warn("warning: historyEnabled is false in config.json — nothing new is being recorded.");
}

const until = new Date();
const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

const snapshots = readHistory(home, { since, until, sources });
const data = buildReport(snapshots, { since, until, days, maxPoints, generatedAt: until });

const out = resolve(
  flag("out") ?? join(home, ".config", "quotacheck-mcp", "reports", `quota-${days}d.html`),
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, renderReport(data), "utf8");

const buckets = data.sources.reduce((n, s) => n + s.series.length, 0);
console.log(
  `${snapshots.length} 条记录 · ${data.sources.length} 个源 · ${buckets} 个配额桶 · 最近 ${days} 天`,
);
if (snapshots.length === 0) {
  console.log(
    "history is empty — run `npx tsx scripts/export-json.ts --force` a few times, or let the menu bar app poll.",
  );
}
console.log(out);
