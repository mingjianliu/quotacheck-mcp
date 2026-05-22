import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGeminiWeb } from "../../src/collectors/gemini-web.js";

const html = readFileSync(
  join(process.cwd(), "tests", "fixtures", "gemini-web-usage.html"),
  "utf8",
);

describe("parseGeminiWeb", () => {
  it("extracts per-model quotas from the usage page HTML", () => {
    const snap = parseGeminiWeb(html, new Date("2026-05-22T02:00:00Z"));
    expect(snap.source).toBe("gemini-web");
    expect(snap.error).toBeUndefined();
    expect(snap.subModels?.length ?? 0).toBeGreaterThan(0);
    for (const m of snap.subModels ?? []) {
      expect(m.limit).toBeGreaterThan(0);
      expect(m.pct).toBeGreaterThanOrEqual(0);
      expect(m.pct).toBeLessThanOrEqual(100);
    }
  });
});
