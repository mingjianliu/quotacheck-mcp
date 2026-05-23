import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseDesignApiResponse,
  type CapturedResponse,
} from "../../src/collectors/claude-design.js";

const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests", "fixtures", "claude-design-api-response.json"),
    "utf8",
  ),
);

describe("parseDesignApiResponse", () => {
  it("extracts design quota from a matching response", () => {
    const responses: CapturedResponse[] = [
      { url: "https://claude.ai/api/account_profile", body: { name: "test" } },
      { url: "https://claude.ai/api/usage", body: fixture },
    ];
    const snap = parseDesignApiResponse(
      responses,
      new Date("2026-05-22T02:00:00Z"),
    );
    expect(snap.source).toBe("claude-design");
    expect(snap.error).toBeUndefined();
    expect(snap.session?.used).toBe(12);
    expect(snap.session?.limit).toBe(100);
    expect(snap.session?.pct).toBe(12);
    expect(snap.session?.resetsAt).toBe("2026-05-22T05:00:00Z");
  });

  it("returns error listing intercepted URLs when no design key found", () => {
    const responses: CapturedResponse[] = [
      { url: "https://claude.ai/api/account_profile", body: { name: "test" } },
    ];
    const snap = parseDesignApiResponse(
      responses,
      new Date("2026-05-22T02:00:00Z"),
    );
    expect(snap.source).toBe("claude-design");
    expect(snap.error).toContain("no design quota API response captured");
    expect(snap.error).toContain("account_profile");
  });

  it("returns error with body when design key has unexpected shape", () => {
    const responses: CapturedResponse[] = [
      {
        url: "https://claude.ai/api/usage",
        body: { design: { something: "unexpected" } },
      },
    ];
    const snap = parseDesignApiResponse(
      responses,
      new Date("2026-05-22T02:00:00Z"),
    );
    expect(snap.source).toBe("claude-design");
    expect(snap.error).toContain("missing expected fields");
  });

  it("returns error with empty intercepted list when no responses given", () => {
    const snap = parseDesignApiResponse([], new Date("2026-05-22T02:00:00Z"));
    expect(snap.error).toContain("no design quota API response captured");
    expect(snap.error).toContain("[]");
  });
});
