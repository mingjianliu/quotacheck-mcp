import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAntigravity,
  collectAntigravity,
} from "../../src/collectors/antigravity.js";

const fixture = readFileSync(
  join(process.cwd(), "tests", "fixtures", "antigravity-usage.json"),
  "utf8",
);

describe("parseAntigravity", () => {
  it("produces a QuotaSnapshot with subModels populated", () => {
    const snap = parseAntigravity(fixture, new Date("2026-05-22T02:00:00Z"));
    expect(snap.source).toBe("antigravity");
    expect(snap.subModels?.map((m) => m.name).sort()).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-pro",
    ]);
    const pro = snap.subModels?.find((m) => m.name === "gemini-2.5-pro");
    expect(pro?.used).toBe(340);
    expect(pro?.limit).toBe(1000);
    expect(pro?.pct).toBe(34);
  });
});

describe("collectAntigravity", () => {
  it("returns error snapshot when binary is missing", async () => {
    const snap = await collectAntigravity({
      binary: "/does/not/exist/antigravity-usage",
      now: new Date(),
    });
    expect(snap.error).toMatch(/antigravity-usage/);
  });

  it("returns error snapshot when binary outputs invalid JSON", async () => {
    const snap = await collectAntigravity({
      binary: "echo",
      args: ["not-json"],
      now: new Date(),
    });
    expect(snap.error).toMatch(/parse/i);
  });
});
