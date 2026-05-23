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

interface CapturedResponse {
  url: string;
  body: unknown;
}

// Walks a JSON value looking for an array of objects each containing a model
// name and quota fields. Returns null when nothing recognisable is found.
function tryParseXhrBodies(
  responses: CapturedResponse[],
  now: Date,
): QuotaSnapshot | null {
  for (const { body } of responses) {
    if (!body || typeof body !== "object") continue;

    const models = extractModelArray(body as Record<string, unknown>);
    if (models && models.length > 0) {
      const subModels: SubModelBucket[] = models.flatMap((m) => {
        const name =
          (m.modelId as string | undefined) ??
          (m.modelName as string | undefined) ??
          (m.name as string | undefined);
        if (!name) return [];

        const qi = m.quotaInfo as Record<string, unknown> | undefined;
        const rawLimit =
          (m.limit as number | undefined) ??
          (qi?.limit as number | undefined) ??
          100;
        const rawUsed =
          (m.used as number | undefined) ??
          (qi?.used as number | undefined) ??
          (qi?.remainingFraction != null
            ? Math.round(rawLimit * (1 - (qi.remainingFraction as number)))
            : 0);

        return [
          {
            name,
            used: rawUsed,
            limit: rawLimit,
            pct: rawLimit > 0 ? (rawUsed / rawLimit) * 100 : 0,
          },
        ];
      });

      if (subModels.length > 0) {
        return {
          source: "gemini-web",
          collectedAt: now.toISOString(),
          subModels,
        };
      }
    }
  }
  return null;
}

function extractModelArray(
  obj: Record<string, unknown>,
): Record<string, unknown>[] | null {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0) {
      const item = val[0] as Record<string, unknown>;
      if (
        item &&
        typeof item === "object" &&
        (item.modelId || item.modelName || item.name) &&
        (item.limit != null || item.quotaInfo != null || item.used != null)
      ) {
        return val as Record<string, unknown>[];
      }
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = extractModelArray(val as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return null;
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
    const captured: CapturedResponse[] = [];
    const page = await context.newPage();

    page.on("response", async (res) => {
      const url = res.url();
      const ct = res.headers()["content-type"] ?? "";
      if (
        url.includes("gemini.google.com") &&
        ct.includes("application/json")
      ) {
        try {
          const body = await res.json();
          captured.push({ url, body });
          console.error(`[gemini-web] captured: ${url}`);
        } catch {
          // ignore parse failures
        }
      }
    });

    await page.goto(USAGE_URL, {
      timeout: opts.timeoutMs,
      waitUntil: "networkidle",
    });

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

    // Try XHR-based parse first
    const xhrResult = tryParseXhrBodies(captured, now);
    if (xhrResult) {
      try {
        const updated = await context.storageState();
        const dir = join(opts.homeDir, ".config", "quotacheck-mcp");
        mkdirSync(dir, { recursive: true });
        writeFileSync(sessionPath, JSON.stringify(updated, null, 2));
      } catch {
        // ignore state refresh failures
      }
      return xhrResult;
    }

    // Fall back to HTML content parse
    const html = await page.content();
    const htmlResult = parseGeminiWeb(html, now);
    if (!htmlResult.error) return htmlResult;

    // Neither approach worked — return captured URLs for debugging
    return {
      source: "gemini-web",
      collectedAt: now.toISOString(),
      error: `Could not extract quota. Intercepted: ${JSON.stringify(captured.map((r) => r.url))}`,
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
