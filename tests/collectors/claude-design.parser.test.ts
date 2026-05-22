import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeDesign } from "../../src/collectors/claude-design.js";

const html = readFileSync(
  join(process.cwd(), "tests", "fixtures", "claude-design-usage.html"),
  "utf8",
);

describe("parseClaudeDesign", () => {
  it("extracts the design quota bucket", () => {
    const snap = parseClaudeDesign(html, new Date("2026-05-22T02:00:00Z"));
    expect(snap.source).toBe("claude-design");
    expect(snap.error).toBeUndefined();
    // Design quota is typically a single bucket (session or daily).
    expect(snap.session?.limit ?? snap.weekly?.limit).toBeGreaterThan(0);
    expect(snap.session?.used).toBe(12);
    expect(snap.session?.limit).toBe(100);
    expect(snap.session?.resetsAt).toBe("2026-05-22T05:00:00Z");
  });
});
