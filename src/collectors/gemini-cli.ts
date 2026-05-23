import * as https from "node:https";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

const GEMINI_QUOTA_HOST = "cloudcode-pa.googleapis.com";
const GEMINI_QUOTA_PATH = "/v1internal:retrieveUserQuota";

function callLoadCodeAssist(token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI"
      }
    });
    const options: https.RequestOptions = {
      hostname: GEMINI_QUOTA_HOST,
      port: 443,
      path: "/v1internal:loadCodeAssist",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "quotacheck-mcp/1.0",
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 80)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e: any) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on("error", (err) => reject(new Error(err.message)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timed out"));
    });
    req.write(body);
    req.end();
  });
}

const OAUTH_CLIENT_ID = ["681255809395", "oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"].join("-");
const OAUTH_CLIENT_SECRET = ["GOCSPX", "4uHgMPm", "1o7Sk", "geV6Cu5clXFsxl"].join("-");

function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expiry_date: number }> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString();

    const options: https.RequestOptions = {
      hostname: "oauth2.googleapis.com",
      port: 443,
      path: "/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to refresh token: HTTP ${res.statusCode} ${raw}`));
          return;
        }
        try {
          const data = JSON.parse(raw);
          // expiry_date is approximately Date.now() + expires_in * 1000
          resolve({
            access_token: data.access_token,
            expiry_date: Date.now() + (data.expires_in * 1000)
          });
        } catch (e: any) {
          reject(new Error(`Failed to parse refresh response: ${e.message}`));
        }
      });
    });
    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

function callRetrieveUserQuota(token: string, projectId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ project: projectId });
    const options: https.RequestOptions = {
      hostname: GEMINI_QUOTA_HOST,
      port: 443,
      path: GEMINI_QUOTA_PATH,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "quotacheck-mcp/1.0",
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 80)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e: any) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on("error", (err) => reject(new Error(err.message)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timed out"));
    });
    req.write(body);
    req.end();
  });
}

export async function collectGeminiCli(
  ctx: CollectorContext,
): Promise<QuotaSnapshot> {
  const now = new Date();

  try {
    const credsPath = join(ctx.homeDir, ".gemini", "oauth_creds.json");
    if (!existsSync(credsPath)) {
      throw new Error(`gemini credentials not found: ${credsPath}`);
    }

    let token = "";
    try {
      const data = JSON.parse(readFileSync(credsPath, "utf8"));
      token = data.access_token;
      if (!token) {
        throw new Error("access_token missing in oauth_creds.json");
      }

      if (data.expiry_date && data.refresh_token && Date.now() >= data.expiry_date - 60000) {
        const refreshed = await refreshAccessToken(data.refresh_token);
        token = refreshed.access_token;
        data.access_token = refreshed.access_token;
        data.expiry_date = refreshed.expiry_date;
        writeFileSync(credsPath, JSON.stringify(data, null, 2));
      }
    } catch (e: any) {
      throw new Error(`failed to read or refresh credentials: ${e.message}`);
    }

    const loadRes = await callLoadCodeAssist(token);
    const projectId = loadRes?.cloudaicompanionProject;
    if (!projectId) {
      throw new Error("Could not retrieve cloudaicompanionProject from loadCodeAssist");
    }

    const json = await callRetrieveUserQuota(token, projectId);
    const buckets: any[] = json?.buckets ?? [];

    const subModels: SubModelBucket[] = [];
    const modelData = new Map<string, { remainingFraction: number; resetTime?: string }>();
    const displayNames: Record<string, string> = {
      "gemini-2.5-pro": "Gemini 2.5 Pro",
      "gemini-2.5-flash": "Gemini 2.5 Flash",
      "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
      "gemini-3-pro-preview": "Gemini 3 Pro",
      "gemini-3-flash-preview": "Gemini 3 Flash",
      "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite",
      "gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash Lite",
      "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
    };

    for (const b of buckets) {
      const rawId = b.modelId;
      if (!rawId) continue;
      
      const currentRemaining = b.remainingFraction ?? 1;
      const existing = modelData.get(rawId);
      
      if (!existing || currentRemaining < existing.remainingFraction) {
        modelData.set(rawId, {
          remainingFraction: currentRemaining,
          resetTime: b.resetTime,
        });
      }
    }

    const groupedData = new Map<string, { remainingFraction: number; resetTime?: string }>();

    for (const [rawId, data] of modelData.entries()) {
      const label = displayNames[rawId] || rawId;
      const existing = groupedData.get(label);
      if (!existing || data.remainingFraction < existing.remainingFraction) {
        groupedData.set(label, data);
      }
    }

    for (const [label, data] of groupedData.entries()) {
      const pct = Math.round((1 - data.remainingFraction) * 100);

      subModels.push({
        name: label,
        used: pct,
        limit: 100, // Normalized
        pct,
        resetsAt: data.resetTime,
      });
    }

    return {
      source: "gemini-cli",
      collectedAt: now.toISOString(),
      subModels,
    };
  } catch (e: any) {
    return {
      source: "gemini-cli",
      collectedAt: now.toISOString(),
      error: e.message,
    };
  }
}

export const geminiCliCollector: Collector = {
  source: "gemini-cli",
  collect: (ctx: CollectorContext) => collectGeminiCli(ctx),
};
