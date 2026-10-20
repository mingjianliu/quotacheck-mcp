import { describe, it, expect } from "vitest";
import { parseQuotaOutput } from "../../src/collectors/antigravity.js";

// Verbatim `agy -p "/quota"` output, tab separated.
const SAMPLE = [
  "Gemini Models\tWeekly Limit Remaining\t56%\t2026-08-26T01:17:29Z",
  "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-08-23T10:47:25Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-08-30T05:47:25Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-08-23T10:47:25Z",
].join("\n");

describe("parseQuotaOutput", () => {
  it("returns one bucket per group and limit window, in a stable order", () => {
    // Group ascending, and within a group the weekly window before the 5-hour
    // one, so the pair reads together and history rows never reshuffle.
    const out = parseQuotaOutput(SAMPLE);
    expect(out.map((b) => b.name)).toEqual([
      "Claude and GPT models · Weekly",
      "Claude and GPT models · 5-hour",
      "Gemini Models · Weekly",
      "Gemini Models · 5-hour",
    ]);
  });

  it("converts remaining into used — agy reports what is left, we report what is spent", () => {
    const gemWeekly = parseQuotaOutput(SAMPLE).find((b) => b.name === "Gemini Models · Weekly")!;
    expect(gemWeekly.pct).toBe(44);
    expect(gemWeekly.used).toBe(44);
    expect(gemWeekly.limit).toBe(100);
  });

  it("carries each window's own reset time", () => {
    const out = parseQuotaOutput(SAMPLE);
    const by = (n: string) => out.find((b) => b.name === n)!;
    expect(by("Gemini Models · Weekly").resetsAt).toBe("2026-08-26T01:17:29Z");
    expect(by("Gemini Models · 5-hour").resetsAt).toBe("2026-08-23T10:47:25Z");
  });

  it("exposes the group explicitly, not only baked into the name", () => {
    // The renderer groups overview tiles by this. Re-splitting the display name
    // on a separator would be a stringly-typed round-trip of what we already know.
    const out = parseQuotaOutput(SAMPLE);
    expect(out.map((b) => b.group)).toEqual([
      "Claude and GPT models",
      "Claude and GPT models",
      "Gemini Models",
      "Gemini Models",
    ]);
    // Names stay stable — they identify series in the recorded history.
    expect(out[2].name).toBe("Gemini Models · Weekly");
  });

  it("keeps fractional percentages", () => {
    const out = parseQuotaOutput("Gemini Models\tWeekly Limit Remaining\t56.34%\t2026-08-26T01:17:29Z");
    expect(out[0].pct).toBeCloseTo(43.66, 2);
  });

  it("tolerates surrounding blank lines and padding", () => {
    const out = parseQuotaOutput("\n\n  " + SAMPLE + "  \n\n");
    expect(out).toHaveLength(4);
  });

  it("skips rows it cannot understand rather than failing the whole read", () => {
    const out = parseQuotaOutput(
      ["Fetching quota...", "garbage line", SAMPLE.split("\n")[0], "a\tb"].join("\n"),
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Gemini Models · Weekly");
  });

  it("returns nothing when the output carries no quota rows", () => {
    expect(parseQuotaOutput("command not found")).toEqual([]);
    expect(parseQuotaOutput("")).toEqual([]);
  });

  it("keeps an unrecognised window label rather than silently dropping the row", () => {
    const out = parseQuotaOutput("Gemini Models\tMonthly Limit Remaining\t80%\t2026-09-01T00:00:00Z");
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Gemini Models · Monthly");
  });

  it("sorts deterministically so history rows stay stable across runs", () => {
    const shuffled = SAMPLE.split("\n").reverse().join("\n");
    expect(parseQuotaOutput(shuffled).map((b) => b.name)).toEqual(
      parseQuotaOutput(SAMPLE).map((b) => b.name),
    );
  });
});

describe("legacy buckets and limits agree", () => {
  it("parses spaced percents and hyphenated windows the same way in both views", async () => {
    const { antigravityLimits } = await import("../../src/source-mapping.js");
    const out = "Gemini\tWeekly Limit Remaining\t80 %\t2026-10-20T00:00:00Z\nGemini\tFive-Hour Limit Remaining\t50%\t2026-10-20T00:00:00Z";
    expect(parseQuotaOutput(out).map((b) => [b.name, b.pct])).toEqual([["Gemini · Weekly", 20], ["Gemini · 5-hour", 50]]);
    expect(antigravityLimits(out).map((l) => [l.label, l.measurement.utilizationPct])).toEqual([["Gemini · Weekly", 20], ["Gemini · 5-hour", 50]]);
  });
});

describe("agy --output-format json", () => {
  // `agy -p /usage --output-format json` as agy 1.3.1 prints it, long descriptions
  // shortened; from Agent HUD's AntigravityCLITests (jazzenchen/agent-hud-open, Apache-2.0).
  const PRINTED = {"conversation_id":"","status":"SUCCESS","response":"Gemini Models\tWeekly Limit Remaining\t75%\t2026-10-20T04:42:34Z","num_turns":0,
    "usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},
    "command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit and a 5-hour limit.","groups":[
      {"name":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro","buckets":[
        {"id":"gemini-weekly","name":"Weekly Limit Remaining","description":"It will fully refresh in 5 days.","window":"weekly","remaining_fraction":0.75,"reset_time":"2026-10-20T04:42:34Z"},
        {"id":"gemini-5h","name":"Five Hour Limit Remaining","description":null,"window":"5h","remaining_fraction":1,"reset_time":"2026-10-15T07:05:34Z"}]},
      {"name":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS","buckets":[
        {"id":"3p-weekly","name":"Weekly Limit Remaining","description":null,"window":"weekly","remaining_fraction":0.5,"reset_time":"2026-10-19T15:09:23Z"},
        {"id":"3p-5h","name":"Five Hour Limit Remaining","description":null,"window":"5h","remaining_fraction":0,"reset_time":"2026-10-15T07:05:34Z"}]}]}}};

  it("reads every group's buckets with the same ids the text table gave", async () => {
    const { agyUsageRows, antigravityLimitsFromRows, antigravityLimits } = await import("../../src/source-mapping.js");
    const rows = agyUsageRows(PRINTED)!;
    const limits = antigravityLimitsFromRows(rows);
    expect(limits.map((l) => [l.id, l.measurement.utilizationPct, l.window.resetsAt])).toEqual([
      ["group:Gemini Models:weekly", 25, "2026-10-20T04:42:34Z"],
      ["group:Gemini Models:session", 0, "2026-10-15T07:05:34Z"],
      ["group:Claude and GPT models:weekly", 50, "2026-10-19T15:09:23Z"],
      ["group:Claude and GPT models:session", 100, "2026-10-15T07:05:34Z"],
    ]);
    // Same id as the /quota table produced, so history continues across the switch.
    expect(antigravityLimits("Gemini Models\tWeekly Limit Remaining\t75%\t2026-10-20T04:42:34Z")[0].id).toBe(limits[0].id);
    expect(limits[0].provenance.identity).toBe("stable");
  });

  it("is not mistaken for other output", async () => {
    const { agyUsageRows } = await import("../../src/source-mapping.js");
    expect(agyUsageRows({ status: "ERROR" })).toBeUndefined();
    expect(agyUsageRows("Gemini\tWeekly\t5%")).toBeUndefined();
  });
});

describe("collectAntigravity", () => {
  const agy = `${process.cwd()}/tests/fixtures/fake-agy.mjs`;
  it("prefers the JSON summary and falls back to the /quota table on older agy", async () => {
    const { collectAntigravity } = await import("../../src/collectors/antigravity.js");
    for (const mode of ["new", "old"]) {
      process.env.FAKE_AGY_MODE = mode;
      const snap = await collectAntigravity({ antigravityUsageBinary: agy });
      expect(snap.error).toBeUndefined();
      expect(snap.limits?.map((l) => [l.id, l.measurement.utilizationPct])).toEqual([["group:Gemini Models:weekly", 60]]);
      expect(Object.keys(snap.raw as object)).toEqual([mode === "new" ? "usage" : "quotaTable"]);
    }
    delete process.env.FAKE_AGY_MODE;
  });
});
