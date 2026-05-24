import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

const USAGE_URL = "https://gemini.google.com/usage";
const SESSION_FILE = "gemini-web-session.json";

// Pure HTML parser — kept for unit testability without a browser.
export function parseGeminiWeb(html: string, now: Date): QuotaSnapshot {
  const subModels: SubModelBucket[] = [];

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

interface BatchCapture {
  url: string;
  rpcId: string;
  payload: unknown;
}

// Gemini batchexecute responses start with )]}'\n (XSSI prefix), then
// size-prefixed chunks. The "size" counts bytes across multiple frames, so
// byte-slicing mis-aligns for non-trivial responses. Instead we scan for
// wrb.fr frames directly with a regex — robust to any chunk layout.
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
    const [count, remainingFraction, modelType] = bucket;
    if (
      typeof count !== "number" ||
      typeof remainingFraction !== "number" ||
      typeof modelType !== "number"
    )
      continue;

    const name = GEMINI_MODEL_NAMES[modelType] ?? `gemini-model-${modelType}`;
    // field[1] is the consumed fraction (0 = none used, 1 = fully used),
    // despite the variable name I originally chose — confirmed against the web UI.
    const usedFraction = remainingFraction;
    const used = Math.round(count * usedFraction);
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

export async function collectGeminiWeb(opts: {
  homeDir: string;
  chromeExecutablePath?: string;
  timeoutMs: number;
  now?: Date;
}): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  const sessionPath = join(
    opts.homeDir,
    ".config",
    "quotacheck-mcp",
    SESSION_FILE,
  );

  if (!existsSync(sessionPath)) {
    return {
      source: "gemini-web",
      collectedAt: now.toISOString(),
      error: `No session found. Run: npx quotacheck-mcp login gemini-web`,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let storageState: any;
  try {
    storageState = JSON.parse(readFileSync(sessionPath, "utf8"));
  } catch (e) {
    return {
      source: "gemini-web",
      collectedAt: now.toISOString(),
      error: `Failed to read session file: ${(e as Error).message}`,
    };
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: opts.chromeExecutablePath,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  try {
    // storageState is typed `any` so it satisfies the overloaded newContext signature
    const context = await browser.newContext({ storageState });
    // Start reading response bodies immediately in the handler (bodies are
    // discarded by Playwright shortly after the response fires — reading them
    // later fails silently). Collect the Promises and await them all after
    // the page wait so we don't check batchCaptured before reads complete.
    const batchCaptured: BatchCapture[] = [];
    const readPromises: Promise<void>[] = [];
    const page = await context.newPage();

    page.on("response", (res) => {
      const url = res.url();
      const ct = res.headers()["content-type"] ?? "";
      if (!url.includes("gemini.google.com")) return;
      if (!ct.includes("application/json") && !ct.includes("text/javascript"))
        return;

      readPromises.push(
        res
          .text()
          .then((text) => {
            if (!text.startsWith(")]}'")) return;
            for (const item of parseBatchExecute(text)) {
              console.error(`[gemini-web] batchexecute rpcId=${item.rpcId}`);
              batchCaptured.push({ url, ...item });
            }
          })
          .catch(() => {}),
      );
    });

    // "networkidle" never fires because Gemini keeps long-polling connections.
    // Use "load", then wait for batchexecute XHR calls + async handlers.
    try {
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

    // Try jSf9Qc batchexecute quota data
    for (const { rpcId, payload } of batchCaptured) {
      if (rpcId === "jSf9Qc") {
        const result = parseJSf9Qc(payload, now);
        if (result) {
          try {
            const updated = await context.storageState();
            const dir = join(opts.homeDir, ".config", "quotacheck-mcp");
            mkdirSync(dir, { recursive: true });
            writeFileSync(sessionPath, JSON.stringify(updated, null, 2));
          } catch {
            // ignore state refresh failures
          }
          return result;
        }
      }
    }

    // Fall back to HTML content parse
    const html = await page.content();
    const htmlResult = parseGeminiWeb(html, now);
    if (!htmlResult.error) return htmlResult;

    // Neither approach worked — return captured rpcIds for debugging
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
    await browser.close();
  }
}

export const geminiWebCollector: Collector = {
  source: "gemini-web",
  collect: (ctx: CollectorContext) =>
    collectGeminiWeb({
      homeDir: ctx.homeDir,
      chromeExecutablePath: ctx.chromeExecutablePath,
      timeoutMs: ctx.playwrightTimeoutMs,
    }),
};
