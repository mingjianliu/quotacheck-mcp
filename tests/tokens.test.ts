import { afterEach, describe, it, expect } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTokenStats } from "../src/tokens.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const MIN = 60000;
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true })));
function home() { const h = mkdtempSync(join(tmpdir(), "qc-tokens-")); homes.push(h); return h; }
const at = (minAgo: number) => new Date(NOW - minAgo * MIN).toISOString();
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const stats = (h: string) => readTokenStats(h, { now: new Date(NOW), userHome: h, env: {} });

const assistant = (id: string, session: string, minAgo: number, usage: object, model = "claude-opus-5-5") =>
  ({ type: "assistant", sessionId: session, cwd: "/work/app", timestamp: at(minAgo), message: { id, model, usage } });

describe("Claude Code transcripts", () => {
  it("counts each message once, skips a fork's inherited lines, and adds sub-agents to their session", () => {
    const h = home();
    const dir = join(h, ".claude", "projects", "-work-app");
    mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
    const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 };
    writeFileSync(join(dir, "s1.jsonl"), jsonl([
      { type: "user", sessionId: "s1", cwd: "/work/app", timestamp: at(60), message: { content: "Fix the login bug\nmore detail" } },
      { type: "ai-title", sessionId: "s1", aiTitle: "Login fix" },
      // Streaming writes one line per content block, each repeating the message's usage.
      assistant("m1", "s1", 59, usage), assistant("m1", "s1", 59, usage),
      assistant("m2", "s1", 30, usage),
      assistant("m3", "s1", 2000, usage), // older than a day
      assistant("m4", "s1", 10, usage, "<synthetic>"),
    ]));
    // A fork's log begins with its parent's lines, which keep the parent's session id.
    writeFileSync(join(dir, "s2.jsonl"), jsonl([assistant("m1", "s1", 59, usage), assistant("m5", "s2", 5, usage)]));
    writeFileSync(join(dir, "s1", "subagents", "agent-x.jsonl"), jsonl([assistant("m6", "s1", 20, usage)]));
    const s = stats(h);
    // m1, m2, m6 in s1 and m5 in s2: four messages of 135 tokens.
    expect(s.totals["claude-code"]).toEqual({ input: 60, output: 80, cacheRead: 400, total: 540 });
    expect(s.sessions.map((x) => [x.id, x.title, x.project, x.total])).toEqual([["s2", "app", "app", 135], ["s1", "Login fix", "app", 405]]);
    expect(s.buckets["claude-code"]!.reduce((a, b) => a + b, 0)).toBe(540);
  });

  it("reads only what was appended since the last pass", () => {
    const h = home();
    const dir = join(h, ".claude", "projects", "p");
    mkdirSync(dir, { recursive: true });
    const usage = { input_tokens: 1, output_tokens: 1 };
    const log = join(dir, "s.jsonl");
    writeFileSync(log, jsonl([assistant("a", "s", 30, usage)]) + JSON.stringify(assistant("b", "s", 20, usage)).slice(0, 20));
    expect(stats(h).totals["claude-code"]!.total).toBe(2);
    // The half-written line is completed, and another follows.
    appendFileSync(log, JSON.stringify(assistant("b", "s", 20, usage)).slice(20) + "\n" + jsonl([assistant("c", "s", 10, usage)]));
    expect(stats(h).totals["claude-code"]!.total).toBe(6);
    expect(stats(h).totals["claude-code"]!.total).toBe(6);
  });
});

describe("Codex rollouts", () => {
  const meta = (id: string, minAgo: number) => ({ type: "session_meta", timestamp: at(minAgo), payload: { id, cwd: "/work/api", timestamp: at(minAgo) } });
  const tokens = (minAgo: number, input: number, cached: number, output: number, last?: object) =>
    ({ type: "event_msg", timestamp: at(minAgo), payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, ...(last ? { last_token_usage: last } : {}) } } });

  it("differences cumulative totals, handles a reset, and ignores inherited fork history", () => {
    const h = home();
    const dir = join(h, ".codex", "sessions", "2026", "10", "21");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-1.jsonl"), jsonl([
      meta("t1", 50),
      // Inherited from the thread this one forked: sets the baseline only.
      tokens(70, 1000, 800, 100),
      { type: "turn_context", timestamp: at(49), payload: { model: "gpt-5" } },
      { type: "event_msg", timestamp: at(49), payload: { type: "user_message", message: "Add pagination" } },
      tokens(40, 1500, 1100, 160),
      tokens(30, 1500, 1100, 160), // unchanged: no event
      // Totals restarted (a compaction): this call is its own last_token_usage.
      tokens(20, 300, 200, 30, { input_tokens: 300, cached_input_tokens: 200, output_tokens: 30 }),
    ]));
    const s = stats(h);
    // (500 input of which 300 cached, 60 out) + (300 of which 200 cached, 30 out)
    expect(s.totals.codex).toEqual({ input: 300, output: 90, cacheRead: 500, total: 890 });
    expect(s.models).toEqual([{ source: "codex", model: "gpt-5", total: 890 }]);
    expect(s.sessions[0]).toMatchObject({ id: "t1", title: "Add pagination", project: "api", total: 890 });
  });
});
