import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHistory,
  readHistory,
  pruneHistory,
  historyDir,
} from "../src/history.js";
import type { QuotaSnapshot } from "../src/types.js";

// Appends without pruning. Tests that are not about retention must not have
// their fixtures swept away by whatever the real clock says on the day they run.
function add(home: string, snapshots: QuotaSnapshot[]): void {
  appendHistory(home, snapshots, { retentionDays: 36_500 });
}

function snap(
  source: QuotaSnapshot["source"],
  collectedAt: string,
  extra: Partial<QuotaSnapshot> = {},
): QuotaSnapshot {
  return { source, collectedAt, ...extra };
}

describe("history store", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "qc-hist-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("appends one JSON line per snapshot and reads it back", () => {
    add(home, [
      snap("claude-code", "2026-08-01T10:00:00.000Z", {
        session: { used: 10, limit: 100, pct: 10 },
      }),
      snap("gemini-cli", "2026-08-01T10:00:00.000Z"),
    ]);
    const out = readHistory(home, { since: new Date("2026-07-01T00:00:00Z") });
    expect(out.map((s) => s.source)).toEqual(["claude-code", "gemini-cli"]);
    expect(out[0].session?.pct).toBe(10);
  });

  it("shards by UTC month of collectedAt, not by wall clock", () => {
    add(home, [
      snap("claude-code", "2026-07-31T23:59:00.000Z"),
      snap("claude-code", "2026-08-01T00:01:00.000Z"),
    ]);
    expect(readdirSync(historyDir(home)).sort()).toEqual([
      "2026-07.jsonl",
      "2026-08.jsonl",
    ]);
  });

  it("appends to an existing shard instead of truncating it", () => {
    add(home, [snap("claude-code", "2026-08-01T10:00:00.000Z")]);
    add(home, [snap("claude-code", "2026-08-01T10:05:00.000Z")]);
    const lines = readFileSync(join(historyDir(home), "2026-08.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
  });

  it("filters reads by exact cutoff, not by whole shard", () => {
    add(home, [
      snap("claude-code", "2026-08-10T00:00:00.000Z"),
      snap("claude-code", "2026-08-20T00:00:00.000Z"),
    ]);
    const out = readHistory(home, { since: new Date("2026-08-15T00:00:00Z") });
    expect(out.map((s) => s.collectedAt)).toEqual(["2026-08-20T00:00:00.000Z"]);
  });

  it("honours an until bound and a source filter", () => {
    add(home, [
      snap("claude-code", "2026-08-10T00:00:00.000Z"),
      snap("gemini-cli", "2026-08-10T00:00:00.000Z"),
      snap("claude-code", "2026-08-25T00:00:00.000Z"),
    ]);
    const out = readHistory(home, {
      since: new Date("2026-08-01T00:00:00Z"),
      until: new Date("2026-08-15T00:00:00Z"),
      sources: ["claude-code"],
    });
    expect(out).toHaveLength(1);
    expect(out[0].collectedAt).toBe("2026-08-10T00:00:00.000Z");
  });

  it("returns events sorted by time even when shards are written out of order", () => {
    add(home, [snap("claude-code", "2026-08-05T00:00:00.000Z")]);
    add(home, [snap("claude-code", "2026-06-05T00:00:00.000Z")]);
    add(home, [snap("claude-code", "2026-07-05T00:00:00.000Z")]);
    const out = readHistory(home, { since: new Date("2026-01-01T00:00:00Z") });
    expect(out.map((s) => s.collectedAt)).toEqual([
      "2026-06-05T00:00:00.000Z",
      "2026-07-05T00:00:00.000Z",
      "2026-08-05T00:00:00.000Z",
    ]);
  });

  it("skips malformed lines instead of throwing", () => {
    mkdirSync(historyDir(home), { recursive: true });
    writeFileSync(
      join(historyDir(home), "2026-08.jsonl"),
      '{"source":"claude-code","collectedAt":"2026-08-01T00:00:00.000Z"}\n' +
        "{not json\n" +
        "\n" +
        '{"source":"gemini-cli","collectedAt":"2026-08-02T00:00:00.000Z"}\n',
    );
    const out = readHistory(home, { since: new Date("2026-08-01T00:00:00Z") });
    expect(out.map((s) => s.source)).toEqual(["claude-code", "gemini-cli"]);
  });

  it("records error snapshots so a gap is distinguishable from zero usage", () => {
    add(home, [snap("gemini-web", "2026-08-01T00:00:00.000Z", { error: "boom" })]);
    const out = readHistory(home, { since: new Date("2026-08-01T00:00:00Z") });
    expect(out[0].error).toBe("boom");
  });

  it("returns nothing when no history has been written", () => {
    expect(readHistory(home, { since: new Date("2026-08-01T00:00:00Z") })).toEqual([]);
  });

  it("prunes only shards whose entire month is older than the cutoff", () => {
    add(home, [
      snap("claude-code", "2026-04-15T00:00:00.000Z"),
      snap("claude-code", "2026-05-15T00:00:00.000Z"),
      snap("claude-code", "2026-08-15T00:00:00.000Z"),
    ]);
    // 90-day cutoff from 2026-08-23 lands on 2026-05-25, so all of April is
    // expired but May is only partly expired and must survive intact.
    pruneHistory(home, 90, new Date("2026-08-23T00:00:00Z"));
    expect(readdirSync(historyDir(home)).sort()).toEqual([
      "2026-05.jsonl",
      "2026-08.jsonl",
    ]);
  });

  it("prunes as a side effect of appending", () => {
    appendHistory(home, [snap("claude-code", "2026-01-15T00:00:00.000Z")], {
      now: new Date("2026-01-15T00:00:00Z"),
    });
    expect(readdirSync(historyDir(home))).toEqual(["2026-01.jsonl"]);
    appendHistory(home, [snap("claude-code", "2026-08-15T00:00:00.000Z")], {
      retentionDays: 90,
      now: new Date("2026-08-15T00:00:00Z"),
    });
    expect(readdirSync(historyDir(home))).toEqual(["2026-08.jsonl"]);
  });

  it("ignores unrelated files in the history directory", () => {
    mkdirSync(historyDir(home), { recursive: true });
    writeFileSync(join(historyDir(home), "README.txt"), "hi");
    add(home, [snap("claude-code", "2026-08-15T00:00:00.000Z")]);
    const out = readHistory(home, { since: new Date("2026-08-01T00:00:00Z") });
    expect(out).toHaveLength(1);
    pruneHistory(home, 1, new Date("2027-01-01T00:00:00Z"));
    expect(readdirSync(historyDir(home))).toEqual(["README.txt"]);
  });
});
