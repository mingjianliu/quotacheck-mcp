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
