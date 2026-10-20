import { codexLimits } from '../source-mapping.js';
import { stableHash } from '../observation.js';
import { spawn } from "node:child_process";
import type {
  Bucket,
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

/**
 * Codex quota comes from the app-server's `account/rateLimits/read` RPC.
 *
 * `codex app-server` is a stdio JSON-RPC service whose protocol (dumped by
 * `codex app-server generate-json-schema`) exposes the same rate-limit snapshot
 * the TUI shows under `/status`. It answers in well under a second, costs no
 * model tokens, and needs no Codex UI running — unlike driving the CLI in print
 * mode. Credentials stay inside Codex; we never touch `~/.codex/auth.json`.
 *
 * The backend reports two windows: `primary` (5 hours on current plans) and
 * `secondary` (weekly). Both are already percentages of their own limit.
 */

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  /** Seconds since the epoch, not an ISO string. */
  resetsAt?: number | null;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

export interface AccountRateLimits {
  /** Single-bucket view; mirrors what the TUI shows. */
  rateLimits: RateLimitSnapshot & { planType?: string | null };
  /** The ChatGPT workspace. Members of one workspace share it, so the email separates users. */
  accountId?: string | null;
  /** Multi-bucket view keyed by metered limit id, e.g. `codex`. */
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}

/** `account/read` result: who `codex login` is currently signed in as. */
export interface CodexAccount {
  type: string;
  email?: string | null;
  planType?: string;
}

const INIT_ID = 1;
const READ_ID = 2;
const ACCOUNT_ID = 3;
const ACCOUNT_GRACE_MS = 2_000;
const RPC_TIMEOUT_MS = 20_000;
const CLIENT_NAME = "quotacheck-mcp";
const CLIENT_VERSION = "0.1.0";

type WindowSlot = "primary" | "secondary";

/** 10080 -> "Weekly", 300 -> "5-hour". An unmeasured window keeps its slot name. */
function windowLabel(
  mins: number | null | undefined,
  slot: WindowSlot,
): string {
  if (mins == null || !Number.isFinite(mins)) {
    return slot === "primary" ? "Primary" : "Secondary";
  }
  if (mins === 10080) return "Weekly";
  if (mins === 1440) return "Daily";
  if (mins % 60 === 0) return `${mins / 60}-hour`;
  return `${mins}-min`;
}

function toIso(resetsAt: number | null | undefined): string | undefined {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt))
    return undefined;
  return new Date(resetsAt * 1000).toISOString();
}

function toBucket(w: RateLimitWindow | null | undefined): Bucket | undefined {
  if (!w || typeof w.usedPercent !== "number") return undefined;
  return {
    used: w.usedPercent,
    limit: 100,
    pct: w.usedPercent,
    resetsAt: toIso(w.resetsAt),
  };
}

/**
 * One bucket per metered limit and window, ordered group-ascending with the
 * longest window first — so a group's weekly sits above its 5-hour and history
 * rows never reshuffle, matching how antigravity's groups read.
 */
function toSubModels(
  byLimitId: Record<string, RateLimitSnapshot>,
): SubModelBucket[] {
  const rows: Array<SubModelBucket & { _rank: number }> = [];

  for (const [key, snap] of Object.entries(byLimitId)) {
    const group = snap?.limitName || snap?.limitId || key;
    for (const slot of ["primary", "secondary"] as WindowSlot[]) {
      const bucket = toBucket(snap?.[slot]);
      if (!bucket) continue;
      const mins = snap[slot]?.windowDurationMins;
      rows.push({
        ...bucket,
        name: `${group} · ${windowLabel(mins, slot)}`,
        group,
        _rank: -(mins ?? 0),
      });
    }
  }

  rows.sort(
    (a, b) =>
      a.group!.localeCompare(b.group!) ||
      a._rank - b._rank ||
      a.name.localeCompare(b.name),
  );
  return rows.map(({ _rank, ...bucket }) => bucket);
}

export function parseRateLimits(
  res: AccountRateLimits,
): Pick<QuotaSnapshot, "session" | "weekly" | "subModels"> {
  const snap = res?.rateLimits ?? {};
  const byLimitId = res?.rateLimitsByLimitId ?? {};

  // A single metered limit is already fully described by session + weekly;
  // breaking it out again would just duplicate those two tiles.
  const subModels =
    Object.keys(byLimitId).length > 1 ? toSubModels(byLimitId) : undefined;

  return {
    session: toBucket(snap.primary),
    weekly: toBucket(snap.secondary),
    subModels: subModels?.length ? subModels : undefined,
  };
}

/**
 * Stable key for the signed-in account, so readings from different logins are
 * never merged. One email can sign in to a personal plan and to a Team
 * workspace, whose quotas differ, so the workspace (`accountId`) joins the
 * email when the backend supplies it. Both are hashed, never stored.
 */
export function codexAccountKey(account: CodexAccount | undefined, workspace?: string | null): string | undefined {
  if (!account || typeof account.type !== "string") return undefined;
  const email = typeof account.email === "string" ? account.email.trim().toLowerCase() : "";
  if (account.type !== "chatgpt") return account.type;
  if (!email) return undefined;
  const ws = typeof workspace === "string" ? workspace.trim() : "";
  return ws ? `chatgpt:${stableHash(email)}:${stableHash(ws)}` : `chatgpt:${stableHash(email)}`;
}

/** "mingjian@gmail.com" + plus -> "m…@gmail.com · plus": enough to tell your own accounts apart. */
export function codexAccountLabel(account: CodexAccount | undefined, plan?: string | null): string | undefined {
  if (!account || typeof account.type !== "string") return undefined;
  if (account.type !== "chatgpt") return account.type;
  const email = typeof account.email === "string" ? account.email.trim() : "";
  const at = email.indexOf("@");
  if (at < 1) return undefined;
  const masked = `${email[0]}…${email.slice(at)}`;
  // The snapshot's plan is the workspace's; account/read's is the login's.
  const shown = plan || account.planType;
  return shown ? `${masked} · ${shown}` : masked;
}

interface CodexRead {
  limits: AccountRateLimits;
  account?: CodexAccount;
}

function readRateLimits(binary: string, signal?: AbortSignal): Promise<CodexRead> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });

    let settled = false;
    let stdout = "";
    let stderr = "";
    let limits: AccountRateLimits | undefined;
    // undefined: not answered yet; null: answered without a usable account.
    let account: CodexAccount | null | undefined;
    const done = () => {
      if (limits !== undefined && account !== undefined)
        finish(() => resolve({ limits: limits!, ...(account ? { account } : {}) }));
    };

    const finish = (act: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      act();
    };

    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `\`${binary} app-server\` did not answer within ${RPC_TIMEOUT_MS}ms`,
            ),
          ),
        ),
      RPC_TIMEOUT_MS,
    );

    const send = (msg: unknown) =>
      child.stdin.write(JSON.stringify(msg) + "\n");

    // Killing the child mid-write races the pipe; the reply is already in hand.
    child.stdin.on("error", () => {});
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) =>
      finish(() =>
        reject(
          new Error(`failed to run \`${binary} app-server\`: ${e.message}`),
        ),
      ),
    );
    child.on("exit", (code) =>
      finish(() =>
        reject(
          new Error(
            `\`${binary} app-server\` exited (${code}) before answering: ${stderr.trim().slice(0, 200)}`,
          ),
        ),
      ),
    );

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      let nl: number;
      while ((nl = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, nl);
        stdout = stdout.slice(nl + 1);
        if (!line.trim()) continue;

        let msg: {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        // The server interleaves notifications and config warnings on the same
        // stream; anything unparseable is chatter, not our reply.
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (msg.id === INIT_ID) {
          send({ method: "initialized", params: null });
          send({
            id: READ_ID,
            method: "account/rateLimits/read",
            params: null,
          });
          // Identity is best effort: a CLI without account/read still reports quota.
          send({ id: ACCOUNT_ID, method: "account/read", params: { refreshToken: false } });
        } else if (msg.id === ACCOUNT_ID) {
          const a = (msg.result as { account?: CodexAccount | null } | undefined)?.account;
          account = !msg.error && a && typeof a === "object" ? a : null;
          done();
        } else if (msg.id === READ_ID) {
          if (msg.error) {
            finish(() =>
              reject(
                new Error(
                  `account/rateLimits/read failed: ${msg.error?.message ?? "unknown error"}`,
                ),
              ),
            );
            return;
          }
          limits = msg.result as AccountRateLimits;
          // Never trade the quota reading for identity: give account/read a moment, no more.
          if (account === undefined) setTimeout(() => { account ??= null; done(); }, ACCOUNT_GRACE_MS);
          done();
        }
      }
    });

    send({
      id: INIT_ID,
      method: "initialize",
      params: { clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION } },
    });
  });
}

export async function collectCodex(
  ctx?: Pick<CollectorContext, "codexBinary" | "signal">,
  opts: {
    now?: Date;
    read?: (binary: string) => Promise<AccountRateLimits | CodexRead>;
  } = {},
): Promise<QuotaSnapshot> {
  const collectedAt = (opts.now ?? new Date()).toISOString();
  const binary = ctx?.codexBinary || "codex";
  const read = opts.read ?? readRateLimits;

  try {
    const result = opts.read ? await read(binary) : await readRateLimits(binary,ctx?.signal);
    const { limits: raw, account } = "limits" in result ? result : { limits: result, account: undefined };
    const parsed = parseRateLimits(raw);
    if (!parsed.session && !parsed.weekly && !parsed.subModels) {
      // A signed-out CLI answers with an empty snapshot. Passing that off as a
      // successful read would park codex at 0% indefinitely.
      throw new Error(
        `\`${binary} app-server\` reported no rate limit window. Is the Codex CLI signed in?`,
      );
    }
    const accountKey = codexAccountKey(account, raw.accountId);
    const label = codexAccountLabel(account, raw.rateLimits?.planType);
    return { source: "codex", collectedAt, ...parsed, limits: codexLimits(raw), ...(accountKey ? { accountKey } : {}),
      extensions: { response: raw, ...(account ? { account: { type: account.type, planType: account.planType, ...(label ? { label } : {}) } } : {}) }, raw };
  } catch (e) {
    return { source: "codex", collectedAt, error: (e as Error).message };
  }
}

export const codexCollector: Collector = {
  source: "codex",
  collect: (ctx) => collectCodex(ctx),
};
