import { launchWithLockWorkaround } from "../utils/playwright.js";
import type { Collector, CollectorContext, QuotaSnapshot } from "../types.js";

const USAGE_URL = "https://claude.ai/settings/usage";

export function parseClaudeDesign(html: string, now: Date): QuotaSnapshot {
  const usedRe = /design[^<]*?(\d[\d,]*)\s*\/\s*(\d[\d,]*)/i;
  const resetRe = /resets?[^<]*?(\d{4}-\d{2}-\d{2}T[\d:]+Z)/i;

  const usedMatch = usedRe.exec(html);
  if (!usedMatch) {
    return {
      source: "claude-design",
      collectedAt: now.toISOString(),
      error: "design quota row not found on page",
    };
  }

  const used = Number(usedMatch[1].replace(/,/g, ""));
  const limit = Number(usedMatch[2].replace(/,/g, ""));
  const resetsAt = resetRe.exec(html)?.[1];

  return {
    source: "claude-design",
    collectedAt: now.toISOString(),
    session: {
      used,
      limit,
      pct: limit > 0 ? (used / limit) * 100 : 0,
      resetsAt,
    },
  };
}

export async function collectClaudeDesign(opts: {
  chromeProfilePath: string;
  chromeExecutablePath?: string;
  timeoutMs: number;
  now?: Date;
}): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  let cleanup: (() => Promise<void> | void) | null = null;
  try {
    const result = await launchWithLockWorkaround(opts.chromeProfilePath, {
      executablePath: opts.chromeExecutablePath,
      timeout: opts.timeoutMs,
    });
    const ctx = result.context;
    cleanup = result.cleanup;

    const page = await ctx.newPage();
    await page.goto(USAGE_URL, {
      timeout: opts.timeoutMs,
      waitUntil: "networkidle",
    });
    const html = await page.content();
    return parseClaudeDesign(html, now);
  } catch (e) {
    return {
      source: "claude-design",
      collectedAt: now.toISOString(),
      error: (e as Error).message,
    };
  } finally {
    if (cleanup) await cleanup();
  }
}

export const claudeDesignCollector: Collector = {
  source: "claude-design",
  collect: (ctx: CollectorContext) =>
    collectClaudeDesign({
      chromeProfilePath: ctx.chromeProfilePath,
      chromeExecutablePath: ctx.chromeExecutablePath,
      timeoutMs: ctx.playwrightTimeoutMs,
    }),
};
