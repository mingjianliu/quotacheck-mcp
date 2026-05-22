import { spawn } from "node:child_process";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

interface RawBucket {
  used: number;
  limit: number;
  resets_at?: string;
}
interface RawModel {
  name: string;
  session?: RawBucket;
  weekly?: RawBucket;
}
interface RawOutput {
  models: RawModel[];
}

function bucketFrom(
  b: RawBucket | undefined,
  name: string,
): SubModelBucket | null {
  if (!b) return null;
  return {
    name,
    used: b.used,
    limit: b.limit,
    pct: b.limit > 0 ? (b.used / b.limit) * 100 : 0,
    resetsAt: b.resets_at,
  };
}

export function parseAntigravity(json: string, now: Date): QuotaSnapshot {
  let raw: RawOutput;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `failed to parse antigravity-usage output: ${(e as Error).message}`,
    );
  }

  const subModels: SubModelBucket[] = [];
  for (const m of raw.models ?? []) {
    const wk = bucketFrom(m.weekly, m.name);
    if (wk) subModels.push(wk);
  }

  return {
    source: "antigravity",
    collectedAt: now.toISOString(),
    subModels: subModels.length ? subModels : undefined,
  };
}

interface AntigravityOpts {
  binary: string;
  args?: string[];
  now?: Date;
  timeoutMs?: number;
}

export async function collectAntigravity(
  opts: AntigravityOpts,
): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  const args = opts.args ?? ["--json"];

  let stdout = "";
  let stderr = "";
  const exit = await new Promise<number | NodeJS.Signals>((resolve) => {
    const child = spawn(opts.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const t = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 5000);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", () => resolve(127));
    child.on("exit", (code, sig) => {
      clearTimeout(t);
      resolve(code ?? sig ?? 0);
    });
  });

  if (exit !== 0) {
    return {
      source: "antigravity",
      collectedAt: now.toISOString(),
      error: `antigravity-usage exited ${exit}: ${stderr.trim() || "no output"}`,
    };
  }

  try {
    return parseAntigravity(stdout, now);
  } catch (e) {
    return {
      source: "antigravity",
      collectedAt: now.toISOString(),
      error: (e as Error).message,
    };
  }
}

export const antigravityCollector: Collector = {
  source: "antigravity",
  collect: (ctx: CollectorContext) =>
    collectAntigravity({ binary: ctx.antigravityUsageBinary }),
};
