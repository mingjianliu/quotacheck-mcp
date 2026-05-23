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
// size-prefixed JSON chunks. Each chunk is an array of frames; frames with
// structure ["wrb.fr", rpcId, escapedPayload, ...] carry the real data.
export function parseBatchExecute(
  text: string,
): Array<{ rpcId: string; payload: unknown }> {
  if (!text.startsWith(")]}'")) return [];

  // Strip )]}'\ n
  let rest = text.slice(text.indexOf("\n") + 1).trimStart();
  const results: Array<{ rpcId: string; payload: unknown }> = [];

  while (rest.length > 0) {
    const nlIdx = rest.indexOf("\n");
    if (nlIdx === -1) break;

    const sizeStr = rest.slice(0, nlIdx).trim();
    const size = parseInt(sizeStr, 10);
    if (isNaN(size) || size <= 0) break;

    rest = rest.slice(nlIdx + 1);
    if (rest.length < size) break;

    const chunk = rest.slice(0, size);
    rest = rest.slice(size).trimStart();

    let frames: unknown;
    try {
      frames = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (!Array.isArray(frames)) continue;

    for (const frame of frames) {
      if (
        Array.isArray(frame) &&
        frame[0] === "wrb.fr" &&
        typeof frame[1] === "string" &&
        typeof frame[2] === "string"
      ) {
        try {
          results.push({ rpcId: frame[1], payload: JSON.parse(frame[2]) });
        } catch {
          // ignore malformed inner JSON
        }
      }
    }
  }

  return results;
}

// jSf9Qc payload: [status, [[count, remainingFraction, modelType, [[resetSec, resetNano]]], ...], bool]
// modelType 1 = Flash, 2 = Pro
const GEMINI_MODEL_NAMES: Record<number, string> = {
  1: "gemini-flash",
  2: "gemini-pro",
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
    const used = Math.round(count * (1 - remainingFraction));
    const pct = (1 - remainingFraction) * 100;

    let resetsAt: string | undefined;
    const timestamps = bucket[3];
    if (
      Array.isArray(timestamps) &&
      Array.isArray(timestamps[0]) &&
      typeof timestamps[0][0] === "number"
    ) {
      resetsAt = new Date(timestamps[0][0] * 1000).toISOString();
    }

    subModels.push({ name, used, limit: count, pct, resetsAt });
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
    const batchCaptured: BatchCapture[] = [];
    const page = await context.newPage();

    page.on("response", async (res) => {
      const url = res.url();
      const ct = res.headers()["content-type"] ?? "";
      if (!url.includes("gemini.google.com")) return;
      if (!ct.includes("application/json") && !ct.includes("text/javascript"))
        return;

      try {
        const text = await res.text();
        if (text.startsWith(")]}'")) {
          for (const item of parseBatchExecute(text)) {
            console.error(`[gemini-web] batchexecute rpcId=${item.rpcId}`);
            batchCaptured.push({ url, ...item });
          }
        }
      } catch {
        // ignore read / parse failures
      }
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
