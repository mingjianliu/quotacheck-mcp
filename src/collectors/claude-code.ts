import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import plans from "../plans.json" with { type: "json" };
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

interface ClaudeCodeOpts {
  homeDir: string;
  projectsDir?: string;
  plan?: keyof typeof plans.anthropic;
  now?: Date;
}

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walkJsonl(full));
    } else if (entry.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

interface UsageLine {
  type?: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

function modelFamily(
  model: string | undefined,
): "opus" | "sonnet" | "haiku" | "other" {
  if (!model) return "other";
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return "other";
}

export async function collectClaudeCode(
  opts: ClaudeCodeOpts,
): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  const projectsDir =
    opts.projectsDir ?? join(opts.homeDir, ".claude", "projects");
  const planKey = opts.plan ?? "pro";
  const plan = plans.anthropic[planKey];

  if (!existsSync(projectsDir)) {
    return {
      source: "claude-code",
      collectedAt: now.toISOString(),
      error: `claude projects dir not found: ${projectsDir}`,
    };
  }

  const sessionCutoff = new Date(
    now.getTime() - plan.sessionWindowHours * 3600_000,
  );
  const weekCutoff = new Date(now.getTime() - 7 * 24 * 3600_000);

  let sessionTotal = 0;
  let weeklyTotal = 0;
  const opusSession = { used: 0 };
  const opusWeekly = { used: 0 };

  for (const file of walkJsonl(projectsDir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      let obj: UsageLine;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = obj.message?.usage;
      if (!usage) continue;
      const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      const ts = obj.timestamp ? new Date(obj.timestamp) : null;
      if (!ts) continue;
      const isOpus = modelFamily(obj.message?.model) === "opus";

      if (ts >= sessionCutoff) {
        sessionTotal += tokens;
        if (isOpus) opusSession.used += tokens;
      }
      if (ts >= weekCutoff) {
        weeklyTotal += tokens;
        if (isOpus) opusWeekly.used += tokens;
      }
    }
  }

  const weeklyResetAt = new Date(
    weekCutoff.getTime() + 7 * 24 * 3600_000,
  ).toISOString();
  const sessionResetAt = new Date(
    sessionCutoff.getTime() + plan.sessionWindowHours * 3600_000,
  ).toISOString();

  const subModels: SubModelBucket[] = [];
  if (plan.weeklyOpusTokens > 0 || opusWeekly.used > 0) {
    subModels.push({
      name: "opus",
      used: opusWeekly.used,
      limit: plan.weeklyOpusTokens,
      pct: plan.weeklyOpusTokens > 0 ? (opusWeekly.used / plan.weeklyOpusTokens) * 100 : 0,
      resetsAt: weeklyResetAt,
    });
  }

  return {
    source: "claude-code",
    collectedAt: now.toISOString(),
    session: {
      used: sessionTotal,
      limit: plan.sessionTokens,
      pct: (sessionTotal / plan.sessionTokens) * 100,
      resetsAt: sessionResetAt,
    },
    weekly: {
      used: weeklyTotal,
      limit: plan.weeklyTokens,
      pct: (weeklyTotal / plan.weeklyTokens) * 100,
      resetsAt: weeklyResetAt,
    },
    subModels: subModels.length ? subModels : undefined,
  };
}

export const claudeCodeCollector: Collector = {
  source: "claude-code",
  collect: (ctx: CollectorContext) =>
    collectClaudeCode({ homeDir: ctx.homeDir }),
};
