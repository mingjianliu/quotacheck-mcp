import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

const USAGE_URL = "https://claude.ai/settings/usage";
const SESSION_FILE = "claude-design-session.json";

export interface CapturedResponse {
  url: string;
  body: unknown;
}

function toUtilBucket(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  if (typeof b.utilization !== "number") return undefined;
  return {
    used: b.utilization,
    limit: 100,
    pct: b.utilization,
    resetsAt: typeof b.resets_at === "string" ? b.resets_at : undefined,
  };
}

export function parseDesignApiResponse(
  responses: CapturedResponse[],
  now: Date,
): QuotaSnapshot {
  const interceptedUrls = responses.map((r) => r.url);

  for (const { body } of responses) {
    if (!body || typeof body !== "object") continue;
    const b = body as Record<string, unknown>;

    // Legacy expected format: { design: { used, limit } }
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

    // Actual format returned by /api/organizations/.../usage —
    // same structure as the OAuth /api/oauth/usage endpoint.
    if ("five_hour" in b && "seven_day" in b) {
      const subModels: SubModelBucket[] = [];
      for (const [key, name] of [
        ["seven_day_opus", "opus"],
        ["seven_day_sonnet", "sonnet"],
        ["seven_day_omelette", "omelette"],
      ] as const) {
        const bk = b[key];
        if (!bk || typeof bk !== "object") continue;
        const { utilization, resets_at } = bk as Record<string, unknown>;
        if (typeof utilization !== "number") continue;
        subModels.push({
          name,
          used: utilization,
          limit: 100,
          pct: utilization,
          resetsAt: typeof resets_at === "string" ? resets_at : undefined,
        });
      }
      const extra = b.extra_usage as Record<string, unknown> | null | undefined;
      if (extra?.is_enabled && typeof extra.used_credits === "number") {
        subModels.push({
          name: `extra_usage_${extra.currency ?? "USD"}`,
          used: extra.used_credits as number,
          limit: (extra.monthly_limit as number) ?? 0,
          pct: (extra.utilization as number) ?? 0,
        });
      }
      return {
        source: "claude-design",
        collectedAt: now.toISOString(),
        session: toUtilBucket(b.five_hour),
        weekly: toUtilBucket(b.seven_day),
        subModels: subModels.length ? subModels : undefined,
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

    try {
      await page.goto(USAGE_URL, {
        timeout: opts.timeoutMs,
        waitUntil: "networkidle",
      });
    } catch (gotoErr) {
      const msg = (gotoErr as Error).message;
      // Timeout is fine — the page loads many background calls; we may already
      // have captured everything we need from the XHR interceptor.
      if (!msg.includes("Timeout") && !msg.includes("timeout")) throw gotoErr;
      console.error(
        "[claude-design] networkidle timeout — checking captured responses",
      );
    }

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
