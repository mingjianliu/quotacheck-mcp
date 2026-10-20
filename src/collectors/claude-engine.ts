/**
 * Claude plan usage read through the installed Claude Code engine.
 *
 * A headless `claude -p` speaking the SDK's stream-json protocol answers a
 * `get_usage` control request with the same `rate_limits` object the OAuth
 * usage endpoint returns. No prompt is sent, so nothing is billed, and the
 * engine uses its own login: no Keychain read, no token handling, no borrowed
 * User-Agent. Approach and protocol details follow Agent HUD
 * (github.com/jazzenchen/agent-hud-open, Apache-2.0), ClaudeEngineUsage.swift.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { stableHash } from "../observation.js";

/** `skip_behaviors` spares the engine a scan of the week's transcripts; older engines ignore it. */
export const USAGE_REQUEST = JSON.stringify({
  type: "control_request",
  request_id: "quotacheck-usage",
  request: { subtype: "get_usage", skip_behaviors: true },
});

export interface EngineUsage {
  rateLimitsAvailable: boolean;
  subscriptionType?: string;
  rateLimits?: Record<string, unknown>;
}

export interface ClaudeIdentity {
  accountKey: string;
  email?: string;
}

/** Thrown with a kind the coordinator schedules by; the message is shown to the user. */
export class ClaudeEngineError extends Error {
  constructor(message: string, readonly kind: "authentication" | "unsupported" | "parse" | "unknown") {
    super(message);
  }
}

function newestFirst(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith("."))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/**
 * Engine candidates: the CLI's install places, its native installer's versions,
 * PATH, the directory of the Node running this service (where `npm i -g` puts
 * `claude` under nvm and similar), then the desktop app's Code-tab engines.
 */
export function engineCandidates(home: string, path = process.env.PATH ?? ""): string[] {
  const desktop = newestFirst(join(home, "Library", "Application Support", "Claude", "claude-code"))
    .flatMap((version) => newestFirst(version).map((build) => join(build, "claude.app", "Contents", "MacOS", "claude")));
  return [
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    ...newestFirst(join(home, ".local", "share", "claude", "versions")),
    ...path.split(delimiter).filter(Boolean).map((dir) => join(dir, "claude")),
    join(dirname(process.execPath), "claude"),
    ...desktop,
  ];
}

export function findEngine(home: string, path?: string): string | undefined {
  return engineCandidates(home, path).find((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Parse one stream-json line; undefined for lines other than the control response. */
export function parseControlResponse(line: string): EngineUsage | undefined {
  if (!line.includes('"control_response"')) return undefined;
  let root: { type?: unknown; response?: { subtype?: unknown; error?: unknown; response?: unknown } };
  try {
    root = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (root?.type !== "control_response" || !root.response || typeof root.response !== "object") return undefined;
  if (root.response.subtype === "error") {
    throw new ClaudeEngineError(`Claude Code engine query failed: ${String(root.response.error ?? "unknown error")}`, "unknown");
  }
  const payload = root.response.response as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") throw new ClaudeEngineError("Claude Code engine returned an empty get_usage response", "parse");
  const limits = payload.rate_limits;
  const available = payload.rate_limits_available === true && !!limits && typeof limits === "object";
  return {
    rateLimitsAvailable: available,
    ...(typeof payload.subscription_type === "string" ? { subscriptionType: payload.subscription_type } : {}),
    ...(available ? { rateLimits: limits as Record<string, unknown> } : {}),
  };
}

interface RunOptions {
  input?: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Resolve as soon as a line satisfies this; the child is then stopped. */
  until?: (line: string) => boolean;
  limit?: number;
}

/** Run the engine, collecting stdout lines; never more than `limit` bytes or `timeoutMs`. */
function run(engine: string, args: string[], opts: RunOptions): Promise<{ lines: string[]; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(engine, args, {
      cwd: opts.cwd,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "quotacheck" },
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal,
    });
    const lines: string[] = [];
    let buf = "", stderr = "", size = 0, settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve({ lines, stderr, code });
    };
    const timer = setTimeout(() => finish(new ClaudeEngineError(
      `Claude Code engine returned no usage within ${opts.timeoutMs / 1000}s${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""}`, "unknown")), opts.timeoutMs);
    child.stdin.on("error", () => {});
    child.stderr.on("data", (d) => { if (stderr.length < 4096) stderr += d; });
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > (opts.limit ?? 8 * 1024 * 1024)) return finish(new ClaudeEngineError("Claude Code engine output too large", "parse"));
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        lines.push(line);
        try {
          if (opts.until?.(line)) return finish();
        } catch (e) {
          // An error answer is still an answer: settle with it rather than wait for the timeout.
          return finish(e as Error);
        }
      }
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code) => {
      if (buf) lines.push(buf);
      finish(undefined, code);
    });
    if (opts.input !== undefined) child.stdin.write(opts.input);
    else child.stdin.end();
  });
}

/** Ask the engine for plan usage. Throws ClaudeEngineError on a definite answer without limits. */
export async function fetchEngineUsage(engine: string, opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number }): Promise<EngineUsage> {
  let usage: EngineUsage | undefined;
  const { stderr } = await run(engine, [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--settings", JSON.stringify({ disableAllHooks: true }),
  ], {
    input: USAGE_REQUEST + "\n", cwd: opts.cwd, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 40_000,
    until: (line) => (usage = parseControlResponse(line)) !== undefined,
  });
  if (!usage) throw new ClaudeEngineError(`Claude Code engine exited without answering get_usage${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""}`, "unknown");
  return usage;
}

/**
 * `get_usage` reports no plan limits both for an API-key login and for no login
 * at all; only `claude auth status` tells them apart. Undefined when unknown.
 */
export async function engineSignedIn(engine: string, opts: { cwd: string; signal?: AbortSignal }): Promise<boolean | undefined> {
  try {
    const { lines } = await run(engine, ["auth", "status", "--json"], { cwd: opts.cwd, signal: opts.signal, timeoutMs: 10_000, limit: 64 * 1024 });
    const status = JSON.parse(lines.join(""));
    return typeof status?.loggedIn === "boolean" ? status.loggedIn : undefined;
  } catch {
    return undefined;
  }
}

/** Claude Code's account profile: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`. */
export function profilePath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR?.trim() || home, ".claude.json");
}

/**
 * Claude Code itself treats the account and organization UUID pair as the
 * login identity. Only their hash is kept; the email is for a masked label.
 */
export function readIdentity(path: string): ClaudeIdentity | undefined {
  if (!existsSync(path)) return undefined;
  let account: { accountUuid?: unknown; organizationUuid?: unknown; emailAddress?: unknown } | undefined;
  try {
    account = JSON.parse(readFileSync(path, "utf8"))?.oauthAccount;
  } catch {
    return undefined;
  }
  const user = typeof account?.accountUuid === "string" ? account.accountUuid : "";
  const org = typeof account?.organizationUuid === "string" ? account.organizationUuid : "";
  if (!user && !org) return undefined;
  return { accountKey: `claude:${stableHash([user, org])}`, ...(typeof account?.emailAddress === "string" ? { email: account.emailAddress } : {}) };
}

/** "someone@example.com", "max" -> "s…@example.com · max". */
export function maskedLabel(email: string | undefined, plan: string | undefined): string | undefined {
  const at = email?.indexOf("@") ?? -1;
  const masked = email && at > 0 ? `${email[0]}…${email.slice(at)}` : undefined;
  return masked && plan ? `${masked} · ${plan}` : masked ?? plan;
}
