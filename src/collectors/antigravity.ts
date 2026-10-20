import { agyRows, agyUsageRows, agyWindowKind, antigravityLimitsFromRows, type AgyRow } from '../source-mapping.js';
import { execFile } from "node:child_process";
import type { Collector, CollectorContext, QuotaSnapshot, SubModelBucket } from "../types.js";

/**
 * Antigravity quota comes from the `agy` CLI, not the local language server.
 *
 * The language server's GetUserStatus only reflects the 5-hour window, and
 * its RetrieveUserQuotaSummary (which does carry the weekly limit) on agy's
 * own server needs a CSRF token that no command line shows. Asking `agy`
 * works whether or not Antigravity.app is running.
 *
 * `agy -p /usage --output-format json` (agy 1.1.11+) prints the summary's
 * groups and buckets as JSON; older builds fall back to the tab-separated
 * `agy -p "/quota"` table. Slash commands expand in print mode, so neither
 * costs model tokens.
 */
const PRINT_TIMEOUT_S = 60;
const EXEC_TIMEOUT_MS = 75_000;

/** "Five Hour Limit Remaining" -> "5-hour". Unknown labels keep their first word. */
function windowLabel(raw: string, period?: string): string {
  const kind = agyWindowKind(raw.trim(), period);
  if (kind === "weekly") return "Weekly";
  if (kind === "session") return "5-hour";
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
  return bucketsFromRows(agyRows(raw));
}

function bucketsFromRows(rows: AgyRow[]): SubModelBucket[] {
  const out: Array<SubModelBucket & { _rank: number; _group: string }> = [];

  for (const { group, window, remaining, reset, period } of rows) {
    const label = windowLabel(window, period);
    const used = round2(100 - remaining);
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

function runAgy(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary, args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024, signal },
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
  ctx?: Pick<CollectorContext, "antigravityUsageBinary" | "signal">,
): Promise<QuotaSnapshot> {
  const collectedAt = new Date().toISOString();
  const binary = ctx?.antigravityUsageBinary || "agy";

  try {
    // agy 1.1.11+ prints its quota summary as JSON; older builds only have the /quota table.
    let rows: AgyRow[] | undefined, raw: Record<string, unknown>;
    let json: unknown;
    try {
      json = JSON.parse(await runAgy(binary, ["-p", "/usage", "--output-format", "json"], ctx?.signal));
      rows = agyUsageRows(json);
    } catch (e) {
      if (ctx?.signal?.aborted) throw e;
    }
    if (rows?.length) {
      raw = { usage: json };
    } else {
      const table = await runAgy(binary, ["-p", "/quota", "--print-timeout", `${PRINT_TIMEOUT_S}s`], ctx?.signal);
      rows = agyRows(table);
      raw = { quotaTable: table };
    }
    if (rows.length === 0) {
      throw new Error(
        `No quota rows in \`${binary} -p /usage\` or \`${binary} -p /quota\` output. Is the Antigravity CLI installed and signed in?`,
      );
    }
    return { source: "antigravity", collectedAt, subModels: bucketsFromRows(rows), limits: antigravityLimitsFromRows(rows), raw, extensions: raw };
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
