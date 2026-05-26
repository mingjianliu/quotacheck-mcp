import { execFile } from "node:child_process";
import { request } from "node:https";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_API_HOST = "api.anthropic.com";
const USAGE_API_PATH = "/api/oauth/usage";
const USAGE_API_USER_AGENT = "claude-code/2.1";
const USAGE_API_TIMEOUT_MS = 15_000;

interface UsageBucket {
  utilization: number;
  resets_at: string;
}

interface UsageApiResponse {
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  seven_day_omelette?: UsageBucket | null;
  seven_day_cowork?: UsageBucket | null;
  seven_day_oauth_apps?: UsageBucket | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number;
    currency: string;
    disabled_reason?: string | null;
  } | null;
}

async function readOauthAccessToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const parsed = JSON.parse(stdout.trim());
          const token = parsed?.claudeAiOauth?.accessToken;
          if (typeof token !== "string" || token.length === 0) {
            reject(
              new Error(
                "claudeAiOauth.accessToken not found in keychain entry",
              ),
            );
          } else {
            resolve(token);
          }
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

function fetchUsage(accessToken: string): Promise<UsageApiResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: USAGE_API_HOST,
        path: USAGE_API_PATH,
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": USAGE_API_USER_AGENT,
        },
        timeout: USAGE_API_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `usage API returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(data) as UsageApiResponse);
          } catch (err) {
            reject(new Error(`failed to parse usage API response: ${err}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`usage API timeout after ${USAGE_API_TIMEOUT_MS}ms`));
    });
    req.end();
  });
}

function toBucket(b: UsageBucket | null | undefined) {
  if (!b) return undefined;
  return {
    used: b.utilization,
    limit: 100,
    pct: b.utilization,
    resetsAt: b.resets_at,
  };
}

async function fetchUsageWithRetry(accessToken: string, retries = 5): Promise<UsageApiResponse> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchUsage(accessToken);
    } catch (err) {
      if (err instanceof Error && err.message.includes("HTTP 429") && i < retries - 1) {
        // Exponential backoff: 2s, 4s, 8s, 16s + jitter
        const delay = Math.pow(2, i + 1) * 1000 + Math.random() * 1000;
        console.error(`[claude-code] Rate limited. Retrying in ${Math.round(delay / 1000)}s...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}

export async function collectClaudeCode(
  opts: {
    now?: Date;
  } = {},
): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  let token: string;
  try {
    token = await readOauthAccessToken();
  } catch (err) {
    return {
      source: "claude-code",
      collectedAt: now.toISOString(),
      error: `failed to read OAuth token from keychain: ${(err as Error).message}`,
    };
  }

  let usage: UsageApiResponse;
  try {
    usage = await fetchUsageWithRetry(token);
  } catch (err) {
    return {
      source: "claude-code",
      collectedAt: now.toISOString(),
      error: (err as Error).message,
    };
  }

  const subModels: SubModelBucket[] = [];
  const subKeys: Array<[string, keyof UsageApiResponse]> = [
    ["opus", "seven_day_opus"],
    ["sonnet", "seven_day_sonnet"],
    ["claude design", "seven_day_omelette"],
  ];
  for (const [name, key] of subKeys) {
    const b = usage[key] as UsageBucket | null | undefined;
    if (!b) continue;
    subModels.push({
      name,
      used: b.utilization,
      limit: 100,
      pct: b.utilization,
      resetsAt: b.resets_at,
    });
  }

  if (usage.extra_usage?.is_enabled) {
    subModels.push({
      name: `extra_usage_${usage.extra_usage.currency}`,
      used: usage.extra_usage.used_credits,
      limit: usage.extra_usage.monthly_limit,
      pct: usage.extra_usage.utilization,
    });
  }

  return {
    source: "claude-code",
    collectedAt: now.toISOString(),
    session: toBucket(usage.five_hour),
    weekly: toBucket(usage.seven_day),
    subModels: subModels.length ? subModels : undefined,
  };
}

export const claudeCodeCollector: Collector = {
  source: "claude-code",
  collect: (_ctx: CollectorContext) => collectClaudeCode(),
};
