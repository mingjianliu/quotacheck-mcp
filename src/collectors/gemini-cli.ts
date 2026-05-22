import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Collector, CollectorContext, QuotaSnapshot } from "../types.js";

// Spike findings (2026-05-22):
//   Inspected ~/.gemini/ directory. state.json only tracks UI banners/tips,
//   and settings.json tracks general config. No session logs are written to ~/.gemini/history/.
//   Therefore, no local files track token usage, and we must fall back to (c):
//   spawning the gemini CLI with `gemini -p "/stats"` and parsing its stdout.

interface GeminiCliOpts {
  stateDir: string;
  now?: Date;
  mockFile?: string;
}

async function runGeminiStats(timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("gemini", ["-p", "/stats"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PAGER: "cat" },
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timeout waiting for gemini stats"));
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Exit code ${code || signal}: ${stderr.trim() || stdout.trim() || "no output"}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export function parseGeminiStatsOutput(output: string, now: Date): QuotaSnapshot {
  const limitMatch = /Usage\s+limit:\s+([\d,]+)/i.exec(output);
  const limit = limitMatch ? parseInt(limitMatch[1].replace(/,/g, ""), 10) : undefined;

  const pctMatch = /(\d+)%\s+used/i.exec(output);
  const isLimitReached = /Limit\s+reached/i.test(output);

  let pct: number | undefined = undefined;
  if (isLimitReached) {
    pct = 100;
  } else if (pctMatch) {
    pct = parseInt(pctMatch[1], 10);
  }

  const resetsMatch = /resets?\s+in\s+([^)\n]+)/i.exec(output);
  let resetsAt: string | undefined = undefined;
  if (resetsMatch && resetsMatch[1]) {
    const relativeText = resetsMatch[1].trim();
    const hrsMatch = /(\d+)h/i.exec(relativeText);
    const minsMatch = /(\d+)m/i.exec(relativeText);
    let durationMs = 0;
    if (hrsMatch) durationMs += parseInt(hrsMatch[1], 10) * 3600 * 1000;
    if (minsMatch) durationMs += parseInt(minsMatch[1], 10) * 60 * 1000;
    if (durationMs > 0) {
      resetsAt = new Date(now.getTime() + durationMs).toISOString();
    }
  }

  if (limit === undefined || pct === undefined) {
    return {
      source: "gemini-cli",
      collectedAt: now.toISOString(),
      error: `Could not parse stats from output: ${output.trim()}`,
    };
  }

  const used = Math.round((pct / 100) * limit);

  return {
    source: "gemini-cli",
    collectedAt: now.toISOString(),
    session: {
      used,
      limit,
      pct,
      resetsAt,
    },
  };
}

export async function collectGeminiCli(
  opts: GeminiCliOpts,
): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  if (!existsSync(opts.stateDir)) {
    return {
      source: "gemini-cli",
      collectedAt: now.toISOString(),
      error: `gemini state dir not found: ${opts.stateDir}`,
    };
  }

  let output = "";
  if (opts.mockFile) {
    const mockPath = join(opts.stateDir, opts.mockFile);
    if (!existsSync(mockPath)) {
      return {
        source: "gemini-cli",
        collectedAt: now.toISOString(),
        error: `mock file not found: ${mockPath}`,
      };
    }
    try {
      output = readFileSync(mockPath, "utf8");
    } catch (e) {
      return {
        source: "gemini-cli",
        collectedAt: now.toISOString(),
        error: `failed to read mock file: ${(e as Error).message}`,
      };
    }
  } else {
    try {
      output = await runGeminiStats(5000);
    } catch (e) {
      return {
        source: "gemini-cli",
        collectedAt: now.toISOString(),
        error: `gemini execution failed: ${(e as Error).message}`,
      };
    }
  }

  return parseGeminiStatsOutput(output, now);
}

export const geminiCliCollector: Collector = {
  source: "gemini-cli",
  collect: (ctx: CollectorContext) =>
    collectGeminiCli({ stateDir: join(ctx.homeDir, ".gemini") }),
};
