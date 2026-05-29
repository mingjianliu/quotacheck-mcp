import { existsSync } from "node:fs";
import { join } from "node:path";
import { launchAuthenticatedContext } from "../utils/playwright.js";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

const USAGE_URL = "https://gemini.google.com/usage";
const LOGIN_HINT = "Run: npx quotacheck-mcp login gemini-web";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
const humanDelay = () => delay(200 + Math.random() * 600);

function sessionPathFor(homeDir: string): string {
  return join(homeDir, ".config", "quotacheck-mcp", "gemini-web-session.json");
}

// The first navigation after a cold browser launch intermittently fails with
// net::ERR_SOCKET_NOT_CONNECTED. Retry transient connection/timeout errors a
// few times before giving up; a real auth problem surfaces later as a redirect.
async function gotoWithRetry(
  page: import("playwright").Page,
  url: string,
  timeoutMs: number,
  attempts = 3,
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { timeout: timeoutMs, waitUntil: "load" });
      return;
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message;
      const transient =
        msg.includes("ERR_SOCKET_NOT_CONNECTED") ||
        msg.includes("ERR_CONNECTION") ||
        msg.includes("Timeout") ||
        msg.includes("timeout");
      if (!transient) throw err;
      await delay(1500);
    }
  }
  // Exhausted retries on a transient error — let the caller treat it as a load
  // timeout (captured responses, if any, are still inspected).
  throw lastErr;
}

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

  subModels.sort((a, b) => a.name.localeCompare(b.name));

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
    subModels.sort((a, b) => a.name.localeCompare(b.name));
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
  sessionPath: string;
  chromeExecutablePath?: string;
  timeoutMs: number;
  now?: Date;
}): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();

  if (!existsSync(opts.sessionPath)) {
    return {
      source: "gemini-web",
      collectedAt: now.toISOString(),
      error: `No saved session at ${opts.sessionPath}. ${LOGIN_HINT}`,
    };
  }

  let cleanup: (() => Promise<void> | void) | null = null;
  try {
    const result = await launchAuthenticatedContext(opts.sessionPath, {
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
      await gotoWithRetry(page, USAGE_URL, opts.timeoutMs);
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
        error: `Session expired. ${LOGIN_HINT}`,
      };
    }
    // When the saved session has expired, /usage silently bounces to /app (the
    // signed-out zero-state) rather than redirecting to accounts.google.com.
    // Detect that so we emit an actionable error instead of a vague parse miss.
    if (!currentUrl.includes("/usage")) {
      return {
        source: "gemini-web",
        collectedAt: now.toISOString(),
        error: `Not signed in — /usage redirected to ${new URL(currentUrl).pathname}. ${LOGIN_HINT}`,
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
      sessionPath: sessionPathFor(ctx.homeDir),
      chromeExecutablePath: ctx.chromeExecutablePath,
      timeoutMs: ctx.playwrightTimeoutMs,
    }),
};
