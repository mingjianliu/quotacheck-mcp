import { exec } from "node:child_process";
import type { Collector, CollectorContext, QuotaSnapshot, SubModelBucket } from "../types.js";

/**
 * Antigravity quota comes from the `agy` CLI, not the local language server.
 *
 * The language server's GetUserStatus does expose a `quotaInfo.remainingFraction`
 * per model, but every model in a group reports the same number because the
 * limit is per *group*, not per model — and it only ever reflects the 5-hour
 * window. The weekly limit, the one that actually runs out, is absent from it,
 * and none of the 237 RPC methods exposes it.
 *
 * `agy -p "/quota"` prints both windows for both groups as tab-separated rows.
 * Slash commands expand in print mode, so this costs no model tokens, and it
 * works whether or not Antigravity.app is running — the RPC needed a live
 * language server process to read a port and CSRF token from.
 */
const PRINT_TIMEOUT_S = 60;
const EXEC_TIMEOUT_MS = 75_000;

/** "Five Hour Limit Remaining" -> "5-hour". Unknown labels keep their first word. */
function windowLabel(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t.startsWith("weekly")) return "Weekly";
  if (t.startsWith("five hour") || t.startsWith("5 hour")) return "5-hour";
  const first = raw.trim().split(/\s+/)[0];
  return first ? first[0].toUpperCase() + first.slice(1) : raw.trim();
}

/** Weekly before 5-hour, then anything else, so a group's pair reads together. */
function windowRank(label: string): number {
  if (label === "Weekly") return 0;
  if (label === "5-hour") return 1;
  return 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Parse `agy -p "/quota"` output.
 *
 * Rows are `group \t window \t remaining% \t resetTime`. agy reports what is
 * *left*; every other collector here reports what is *spent*, so this inverts.
 * Unparseable lines are skipped rather than failing the read — the CLI prints
 * progress chatter alongside the table.
 */
export function parseQuotaOutput(raw: string): SubModelBucket[] {
  const out: Array<SubModelBucket & { _rank: number; _group: string }> = [];

  for (const line of raw.split("\n")) {
    const cells = line.split("\t").map((c) => c.trim());
    if (cells.length < 3) continue;

    const [group, rawWindow, rawPct, rawReset] = cells;
    if (!group || !rawWindow) continue;

    const m = /^([0-9]+(?:\.[0-9]+)?)\s*%$/.exec(rawPct ?? "");
    if (!m) continue;
    const remaining = Number(m[1]);
    if (!Number.isFinite(remaining)) continue;

    const label = windowLabel(rawWindow);
    const used = round2(100 - remaining);
    const reset = rawReset && !Number.isNaN(Date.parse(rawReset)) ? rawReset : undefined;

    out.push({
      name: `${group} · ${label}`,
      group,
      used,
      limit: 100,
      pct: used,
      resetsAt: reset,
      _rank: windowRank(label),
      _group: group,
    });
  }

  out.sort((a, b) => a._group.localeCompare(b._group) || a._rank - b._rank || a.name.localeCompare(b.name));
  return out.map(({ _rank, _group, ...bucket }) => bucket);
}

function runAgy(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      `${binary} -p "/quota" --print-timeout ${PRINT_TIMEOUT_S}s`,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        // A non-zero exit with usable rows on stdout still beats reporting a
        // failure, so the output is judged by the caller, not the exit code.
        if (err && !stdout.trim()) {
          reject(new Error((stderr || err.message).trim().slice(0, 200)));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function collectAntigravity(
  ctx?: Pick<CollectorContext, "antigravityUsageBinary">,
): Promise<QuotaSnapshot> {
  const collectedAt = new Date().toISOString();
  const binary = ctx?.antigravityUsageBinary || "agy";

  try {
    const stdout = await runAgy(binary);
    const subModels = parseQuotaOutput(stdout);
    if (subModels.length === 0) {
      throw new Error(
        `No quota rows in \`${binary} -p "/quota"\` output. Is the Antigravity CLI installed and signed in?`,
      );
    }
    return { source: "antigravity", collectedAt, subModels };
  } catch (e) {
    return {
      source: "antigravity",
      collectedAt,
      error: (e as Error).message,
    };
  }
}

export const antigravityCollector: Collector = {
  source: "antigravity",
  collect: (ctx) => collectAntigravity(ctx),
};
