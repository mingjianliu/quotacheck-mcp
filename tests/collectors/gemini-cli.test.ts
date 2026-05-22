import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { collectGeminiCli } from "../../src/collectors/gemini-cli.js";

describe("collectGeminiCli", () => {
  it("parses session quota from gemini state (successful stats)", async () => {
    const snap = await collectGeminiCli({
      stateDir: join(process.cwd(), "tests", "fixtures", "gemini-state"),
      now: new Date("2026-05-22T02:00:00Z"),
      mockFile: "stdout.txt",
    });
    expect(snap.source).toBe("gemini-cli");
    expect(snap.error).toBeUndefined();
    expect(snap.session?.used).toBe(150);
    expect(snap.session?.limit).toBe(1000);
    expect(snap.session?.pct).toBe(15);
    expect(snap.session?.resetsAt).toBeDefined();
  });

  it("parses session quota from gemini state (limit reached)", async () => {
    const snap = await collectGeminiCli({
      stateDir: join(process.cwd(), "tests", "fixtures", "gemini-state"),
      now: new Date("2026-05-22T02:00:00Z"),
      mockFile: "stdout_limit_reached.txt",
    });
    expect(snap.source).toBe("gemini-cli");
    expect(snap.error).toBeUndefined();
    expect(snap.session?.used).toBe(1000);
    expect(snap.session?.limit).toBe(1000);
    expect(snap.session?.pct).toBe(100);
    expect(snap.session?.resetsAt).toBeDefined();
  });

  it("returns error when state dir is missing", async () => {
    const snap = await collectGeminiCli({
      stateDir: "/does/not/exist",
      now: new Date(),
    });
    expect(snap.error).toBeTruthy();
  });
});
