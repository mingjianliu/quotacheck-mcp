import { launchWithLockWorkaround } from "../utils/playwright.js";
import type { Collector, CollectorContext, QuotaSnapshot } from "../types.js";

const USAGE_URL = "https://claude.ai/settings/usage";

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

    const captured: CapturedResponse[] = [];
    const page = await ctx.newPage();

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

    return parseDesignApiResponse(captured, now);
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
