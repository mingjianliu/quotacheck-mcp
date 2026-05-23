import { launchWithLockWorkaround } from "../utils/playwright.js";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

const USAGE_URL = "https://gemini.google.com/usage";

// Pure parser — separated for unit testability without a browser.
export function parseGeminiWeb(html: string, now: Date): QuotaSnapshot {
  const subModels: SubModelBucket[] = [];

  // Selector strategy: each per-model row exposes its name, used count,
  // and limit. Update these regexes after inspecting the captured fixture.
  const rowRe =
    /<div[^>]*data-model="([^"]+)"[^>]*>[\s\S]*?<span[^>]*data-used>(\d+)<\/span>[\s\S]*?<span[^>]*data-limit>(\d+)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    const used = Number(m[2]);
    const limit = Number(m[3]);
    subModels.push({
      name: m[1],
      used,
      limit,
      pct: limit > 0 ? (used / limit) * 100 : 0,
    });
  }

  if (subModels.length === 0) {
    return {
      source: "gemini-web",
      collectedAt: now.toISOString(),
      error: "no model rows matched — page structure may have changed",
    };
  }

  return {
    source: "gemini-web",
    collectedAt: now.toISOString(),
    subModels,
  };
}

export async function collectGeminiWeb(opts: {
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
      waitUntil: "domcontentloaded",
    });
    // Wait a bit for JS to render
    await page.waitForTimeout(3000);
    const html = await page.content();
    return parseGeminiWeb(html, now);
  } catch (e) {
    return {
      source: "gemini-web",
      collectedAt: now.toISOString(),
      error: (e as Error).message,
    };
  } finally {
    if (cleanup) await cleanup();
  }
}

export const geminiWebCollector: Collector = {
  source: "gemini-web",
  collect: (ctx: CollectorContext) =>
    collectGeminiWeb({
      chromeProfilePath: ctx.chromeProfilePath,
      chromeExecutablePath: ctx.chromeExecutablePath,
      timeoutMs: ctx.playwrightTimeoutMs,
    }),
};
