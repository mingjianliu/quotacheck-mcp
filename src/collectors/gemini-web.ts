import { launchWithLockWorkaround } from "../utils/playwright.js";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

const USAGE_URL = "https://gemini.google.com/usage";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
const humanDelay = () => delay(200 + Math.random() * 600);

// Gemini batchexecute responses start with )]}'\n (XSSI prefix), then
// size-prefixed chunks. The "size" counts bytes across multiple frames, so
// byte-slicing mis-aligns for non-trivial responses. Instead we scan for
// wrb.fr frames directly with a regex — robust to any chunk layout.
interface BatchCapture {
  url: string;
  rpcId: string;
  payload: unknown;
}

export function parseBatchExecute(
  text: string,
): Array<{ rpcId: string; payload: unknown }> {
  if (!text.startsWith(")]}'")) return [];

  // Match: ["wrb.fr","<rpcId>","<escaped-payload>", ...]
  // The payload is a JSON-encoded string, so we capture the escaped content
  // between the quotes and re-parse it as a string then as JSON.
  const frameRe = /\["wrb\.fr","([^"]+)","((?:[^"\\]|\\.)*)"/g;
  const results: Array<{ rpcId: string; payload: unknown }> = [];

  let m: RegExpExecArray | null;
  while ((m = frameRe.exec(text)) !== null) {
    const rpcId = m[1];
    try {
      // m[2] is the escaped inner content; wrap in quotes to form a valid
      // JSON string, parse to get the raw payload string, then parse that.
      const inner = JSON.parse(`"${m[2]}"`);
      results.push({ rpcId, payload: JSON.parse(inner) });
    } catch {
      // ignore malformed frames
    }
  }

  return results;
}

// jSf9Qc payload: [status, [[count, remainingFraction, modelType, [[resetSec, resetNano]]], ...], bool]
// modelType 1 = Flash, 2 = Pro
const GEMINI_MODEL_NAMES: Record<number, string> = {
  1: "session quota",
  2: "weekly quota",
};

export function parseJSf9Qc(payload: unknown, now: Date): QuotaSnapshot | null {
  if (!Array.isArray(payload) || payload.length < 2) return null;

  const buckets = payload[1];
  if (!Array.isArray(buckets) || buckets.length === 0) return null;

  const subModels: SubModelBucket[] = [];

  for (const bucket of buckets) {
    if (!Array.isArray(bucket) || bucket.length < 3) continue;
    if (
      typeof bucket[0] !== "number" ||
      typeof bucket[1] !== "number" ||
      typeof bucket[2] !== "number"
    )
      continue;

    const [, remainingFraction, modelType] = bucket;
    const name = GEMINI_MODEL_NAMES[modelType] ?? `gemini-model-${modelType}`;
    // field[1] is the consumed fraction (0 = none used, 1 = fully used),
    // despite the variable name I originally chose — confirmed against the web UI.
    const usedFraction = remainingFraction;
    const pct = usedFraction * 100;

    let resetsAt: string | undefined;
    const timestamps = bucket[3];
    if (
      Array.isArray(timestamps) &&
      Array.isArray(timestamps[0]) &&
      typeof timestamps[0][0] === "number"
    ) {
      resetsAt = new Date(timestamps[0][0] * 1000).toISOString();
    }

    subModels.push({ name, used: Math.round(pct), limit: 100, pct, resetsAt });
  }

  if (subModels.length === 0) return null;

  return {
    source: "gemini-web",
    collectedAt: now.toISOString(),
    subModels,
  };
}

// Pure HTML parser — kept for unit testability without a browser.
export function parseGeminiWeb(html: string, now: Date): QuotaSnapshot {
  const subModels: SubModelBucket[] = [];

  const rowRe =
    /<div[^>]*data-model="([^"]+)"[^>]*>[\s\S]*?<span[^>]*data-used>(\d+)<\/span>[\s\S]*?<span[^>]*data-limit>(\d+)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const name = m[1];
    const used = Number.parseInt(m[2], 10);
    const limit = Number.parseInt(m[3], 10);
    subModels.push({
      name,
      used,
      limit,
      pct: limit > 0 ? (used / limit) * 100 : 0,
    });
  }

  if (subModels.length > 0) {
    return {
      source: "gemini-web",
      collectedAt: now.toISOString(),
      subModels,
    };
  }

  return {
    source: "gemini-web",
    collectedAt: now.toISOString(),
    error: "No quota rows found in HTML content",
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
    const context = result.context;
    cleanup = result.cleanup;

    const batchCaptured: BatchCapture[] = [];
    const readPromises: Promise<void>[] = [];
    const page = await context.newPage();

    page.on("response", (res) => {
      const url = res.url();
      const ct = res.headers()["content-type"] ?? "";
      if (!url.includes("gemini.google.com")) return;

      const isBatchExecute = url.includes("batchexecute");
      if (
        !isBatchExecute &&
        !ct.includes("application/json") &&
        !ct.includes("text/javascript")
      )
        return;

      readPromises.push(
        res
          .text()
          .then((text) => {
            if (!text.startsWith(")]}'")) return;
            for (const item of parseBatchExecute(text)) {
              batchCaptured.push({ url, ...item });
            }
          })
          .catch(() => {}),
      );
    });

    try {
      await humanDelay();
      await page.goto(USAGE_URL, {
        timeout: opts.timeoutMs,
        waitUntil: "load",
      });
    } catch (gotoErr) {
      const msg = (gotoErr as Error).message;
      if (!msg.includes("Timeout") && !msg.includes("timeout")) throw gotoErr;
      console.error("[gemini-web] load timeout — checking captured responses");
    }
    await page.waitForTimeout(5000);
    await Promise.all(readPromises);

    const currentUrl = page.url();
    if (currentUrl.includes("google.com/sorry/index")) {
      return {
        source: "gemini-web",
        collectedAt: now.toISOString(),
        error: `Google CAPTCHA encountered. Open Chrome with your profile and solve the CAPTCHA at gemini.google.com.`,
      };
    }
    if (
      currentUrl.includes("accounts.google.com") ||
      currentUrl.includes("/signin")
    ) {
      return {
        source: "gemini-web",
        collectedAt: now.toISOString(),
        error: `Session expired. Run: npx quotacheck-mcp login gemini-web`,
      };
    }

    for (const { rpcId, payload } of batchCaptured) {
      if (rpcId === "jSf9Qc") {
        const result = parseJSf9Qc(payload, now);
        if (result) return result;
      }
    }

    const html = await page.content();
    const htmlResult = parseGeminiWeb(html, now);
    if (!htmlResult.error) return htmlResult;

    const capturedIds = batchCaptured.map((c) => c.rpcId);
    return {
      source: "gemini-web",
      collectedAt: now.toISOString(),
      error: `Could not extract quota. batchexecute rpcIds: ${JSON.stringify(capturedIds)}`,
    };
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
