import { retryAt } from '../source-mapping.js';
import { classifyError, type CollectionError } from '../observation.js';
import { parseClaudeUsage } from '../claude-usage.js';
import { execFile } from "node:child_process";
import { request } from "node:https";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
} from "../types.js";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_API_HOST = "api.anthropic.com";
const USAGE_API_PATH = "/api/oauth/usage";
const USAGE_API_USER_AGENT = "claude-code/2.1.4";
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

async function readOauthAccessToken(signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 3000, signal },
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

function fetchUsage(accessToken: string, signal?: AbortSignal): Promise<UsageApiResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        signal,
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
          if (res.statusCode === 429) {
            // This endpoint applies an *escalating* penalty: every request made
            // while rate-limited pushes retry-after further out. So we never
            // retry here — we surface retry-after and let the cache cover the gap.
            const retryAfter = res.headers["retry-after"];
            const message = `usage API rate-limited (HTTP 429)${retryAfter ? `; Retry-After: ${retryAfter}` : ''}`;
            reject(Object.assign(new Error(message), { detail: { kind: 'rate_limited', message, retryAt: retryAt(typeof retryAfter === 'string' ? retryAfter : undefined) } }));
            return;
          }
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `usage API returned HTTP ${res.statusCode}`,
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

export async function collectClaudeCode(
  opts: {
    now?: Date;
    signal?: AbortSignal;
    platform?: NodeJS.Platform;
  } = {},
): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  let token: string;
  try {
    if ((opts.platform ?? process.platform) !== "darwin") return { source: "claude-code", collectedAt: now.toISOString(), error: "Claude Keychain credentials are unsupported on this platform", collectionError: {kind:"unsupported", message:"Claude Keychain credentials are unsupported on this platform"} };
    token = await readOauthAccessToken(opts.signal);
  } catch (err) {
    return {
      source: "claude-code",
      collectedAt: now.toISOString(),
      error: `failed to read OAuth token from keychain: ${(err as Error).message}`,
    };
  }

  let usage: UsageApiResponse;
  try {
    usage = await fetchUsage(token, opts.signal);
  } catch (err) {
    return {
      source: "claude-code",
      collectedAt: now.toISOString(),
      error: (err as Error).message,
      collectionError: (err as Error & {detail?: CollectionError}).detail ?? classifyError((err as Error).message),
    };
  }

  try { return parseClaudeUsage(usage, now.toISOString()); }
  catch (err) { return { source: "claude-code", collectedAt: now.toISOString(), error: String(err), collectionError: { kind: "parse", message: String(err) } }; }

}

export const claudeCodeCollector: Collector = {
  source: "claude-code",
  collect: (ctx: CollectorContext) => collectClaudeCode({signal:ctx.signal}),
};
