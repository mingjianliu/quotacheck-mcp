import { exec } from "node:child_process";
import * as https from "node:https";
import type { Collector, QuotaSnapshot, SubModelBucket } from "../types.js";

const GRPC_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";

function runCommand(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
      err ? reject(new Error(stderr || err.message)) : resolve(stdout);
    });
  });
}

async function detectServerInfo(): Promise<{
  ports: number[];
  csrfToken: string;
} | null> {
  let psOut: string;
  try {
    psOut = await runCommand("ps aux");
  } catch {
    return null;
  }

  let pid: string | null = null;
  let csrfToken: string | null = null;

  for (const line of psOut.split("\n")) {
    if (!line.includes("language_server")) continue;
    const csrfMatch = line.match(/--csrf_token[=\s]+([A-Za-z0-9._/=+-]+)/);
    if (!csrfMatch) continue;

    const parts = line.trim().split(/\s+/);
    pid = parts[1];
    csrfToken = csrfMatch[1];
    break;
  }

  if (!pid || !csrfToken) return null;

  const ports: number[] = [];
  try {
    const isMac = process.platform === "darwin";
    if (isMac) {
      const out = await runCommand(
        `lsof -iTCP -sTCP:LISTEN -a -p ${pid} -n -P`,
      );
      const portRegex = /(?:localhost|127\.0\.0\.1|::1|\*):(\d+)/gi;
      let m: RegExpExecArray | null;
      while ((m = portRegex.exec(out)) !== null) {
        ports.push(parseInt(m[1], 10));
      }
    } else {
      const out = await runCommand(`ss -tlnp | grep "pid=${pid}"`);
      const portRegex = /127\.0\.0\.1:(\d+)/g;
      let m: RegExpExecArray | null;
      while ((m = portRegex.exec(out)) !== null) {
        ports.push(parseInt(m[1], 10));
      }
    }
  } catch {
    // Port discovery failed
  }

  return { ports, csrfToken };
}

function callGetUserStatus(port: number, csrfToken: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = "{}";
    const options: https.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: GRPC_PATH,
      method: "POST",
      rejectUnauthorized: false,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-codeium-csrf-token": csrfToken,
      },
      timeout: 6000,
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

export async function collectAntigravity(): Promise<QuotaSnapshot> {
  const now = new Date();

  try {
    const info = await detectServerInfo();
    if (!info || info.ports.length === 0) {
      throw new Error(
        "Antigravity language server not found or ports unavailable.",
      );
    }

    let json: any = null;
    let lastError: Error | null = null;
    for (const port of info.ports) {
      try {
        json = await callGetUserStatus(port, info.csrfToken);
        if (json) break;
      } catch (e) {
        lastError = e as Error;
      }
    }

    if (!json) {
      throw (
        lastError || new Error("Failed to contact language server on any port.")
      );
    }

    const configs: any[] =
      json?.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [];
    const subModels: SubModelBucket[] = [];
    const seen = new Set<string>();

    for (const c of configs) {
      const label = c.label ?? c.name ?? "Unknown";
      if (seen.has(label)) continue;
      seen.add(label);

      const qi = c.quotaInfo ?? {};
      // resetTime present + no remainingFraction = exhausted quota (100% used)
      // no quotaInfo at all = unlimited/unknown = 0% used
      const remaining: number =
        "remainingFraction" in qi
          ? qi.remainingFraction
          : "resetTime" in qi
            ? 0
            : 1;
      const pct = Math.round((1 - remaining) * 100);

      subModels.push({
        name: label,
        used: pct,
        limit: 100,
        pct,
        resetsAt: qi.resetTime,
      });
    }

    return {
      source: "antigravity",
      collectedAt: now.toISOString(),
      subModels,
    };
  } catch (e: any) {
    return {
      source: "antigravity",
      collectedAt: now.toISOString(),
      error: e.message,
    };
  }
}

export const antigravityCollector: Collector = {
  source: "antigravity",
  collect: () => collectAntigravity(),
};
