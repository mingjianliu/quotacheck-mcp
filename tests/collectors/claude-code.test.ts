import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { collectClaudeCode } from "../../src/collectors/claude-code.js";

const fixtureHome = join(process.cwd(), "tests", "fixtures");

describe("collectClaudeCode", () => {
  it("aggregates token usage from all jsonl files", async () => {
    const snap = await collectClaudeCode({
      homeDir: fixtureHome,
      projectsDir: join(fixtureHome, "claude-projects"),
      plan: "pro",
      now: new Date("2026-05-22T02:00:00Z"),
    });

    expect(snap.source).toBe("claude-code");
    expect(snap.error).toBeUndefined();
    // sonnet: (1000+200)+(2000+400) = 3600; opus: 500+100 = 600; total = 4200
    expect(snap.session?.used).toBe(4200);
    expect(snap.session?.limit).toBe(11000000);
    expect(snap.subModels?.find((m) => m.name === "opus")?.used).toBe(600);
  });

  it("returns error snapshot when projects dir is missing", async () => {
    const snap = await collectClaudeCode({
      homeDir: fixtureHome,
      projectsDir: join(fixtureHome, "does-not-exist"),
      plan: "pro",
      now: new Date(),
    });
    expect(snap.error).toMatch(/projects/i);
  });
});
