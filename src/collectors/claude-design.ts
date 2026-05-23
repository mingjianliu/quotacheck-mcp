import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Collector, CollectorContext, QuotaSnapshot } from "../types.js";

const USAGE_URL = "https://claude.ai/settings/usage";
const SESSION_FILE = "claude-design-session.json";

export interface CapturedResponse {
  url: string;
  body: unknown;
}

export function parseDesignApiResponse(
  responses: CapturedResponse[],
  now: Date,
): QuotaSnapshot {
  const interceptedUrls = responses.map((r) => r.url);

  for (const { body } of responses) {
    if (!body || typeof body !== "object") continue;
    const b = body as Record<string, unknown>;

    if (b.design && typeof b.design === "object") {
      const d = b.design as Record<string, unknown>;
      if (typeof d.used === "number" && typeof d.limit === "number") {
        return {
          source: "claude-design",
          collectedAt: now.toISOString(),
          session: {
            used: d.used,
            limit: d.limit,
            pct: d.limit > 0 ? (d.used / d.limit) * 100 : 0,
            resetsAt: typeof d.resets_at === "string" ? d.resets_at : undefined,
          },
        };
      }
      return {
        source: "claude-design",
        collectedAt: now.toISOString(),
        error: `design API response missing expected fields; body: ${JSON.stringify(body).slice(0, 300)}`,
      };
    }
  }

  return {
    source: "claude-design",
    collectedAt: now.toISOString(),
    error: `no design quota API response captured; intercepted: ${JSON.stringify(interceptedUrls)}`,
  };
}

export async function collectClaudeDesign(opts: {
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
      source: "claude-design",
      collectedAt: now.toISOString(),
      error: `No session found. Run: npx quotacheck-mcp login claude-design`,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let storageState: any;
  try {
    storageState = JSON.parse(readFileSync(sessionPath, "utf8"));
  } catch (e) {
    return {
      source: "claude-design",
      collectedAt: now.toISOString(),
      error: `Failed to read session file: ${(e as Error).message}`,
    };
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: opts.chromeExecutablePath,
  });

  try {
    // storageState is typed `any` so it satisfies the overloaded newContext signature
    const context = await browser.newContext({ storageState });
    const captured: CapturedResponse[] = [];
    const page = await context.newPage();

    page.on("response", async (res) => {
      const url = res.url();
      const ct = res.headers()["content-type"] ?? "";
      if (url.includes("claude.ai/api/") && ct.includes("application/json")) {
        try {
          const body = await res.json();
          captured.push({ url, body });
          console.error(`[claude-design] captured: ${url}`);
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
    if (currentUrl.includes("/login") || currentUrl.includes("login?from=")) {
      return {
        source: "claude-design",
        collectedAt: now.toISOString(),
        error: `Session expired. Run: npx quotacheck-mcp login claude-design`,
      };
    }

    try {
      const updated = await context.storageState();
      const dir = join(opts.homeDir, ".config", "quotacheck-mcp");
      mkdirSync(dir, { recursive: true });
      writeFileSync(sessionPath, JSON.stringify(updated, null, 2));
    } catch {
      // ignore state refresh failures
    }

    return parseDesignApiResponse(captured, now);
  } finally {
    await browser.close();
  }
}

export const claudeDesignCollector: Collector = {
  source: "claude-design",
  collect: (ctx: CollectorContext) =>
    collectClaudeDesign({
      homeDir: ctx.homeDir,
      chromeExecutablePath: ctx.chromeExecutablePath,
      timeoutMs: ctx.playwrightTimeoutMs,
    }),
};
