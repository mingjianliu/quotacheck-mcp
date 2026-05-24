import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseGeminiWeb,
  parseBatchExecute,
  parseJSf9Qc,
} from "../../src/collectors/gemini-web.js";

const html = readFileSync(
  join(process.cwd(), "tests", "fixtures", "gemini-web-usage.html"),
  "utf8",
);

const NOW = new Date("2026-05-22T02:00:00Z");

describe("parseGeminiWeb", () => {
  it("extracts per-model quotas from the usage page HTML", () => {
    const snap = parseGeminiWeb(html, NOW);
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

describe("parseBatchExecute", () => {
  function makeText(payload: unknown): string {
    const inner = JSON.stringify(JSON.stringify(payload));
    const frame = JSON.stringify([
      ["wrb.fr", "jSf9Qc", JSON.parse(inner), null, null, null, "generic"],
    ]);
    return `)]}'
\n${frame.length}\n${frame}`;
  }

  it("returns empty array for non-XSSI text", () => {
    expect(parseBatchExecute("{}")).toEqual([]);
    expect(parseBatchExecute("")).toEqual([]);
  });

  it("extracts rpcId and payload from a wrb.fr frame", () => {
    const payload = [
      2,
      [
        [2400, 0, 1, [[1779588120, 0]]],
        [30943, 0.36, 2, [[1779778920, 0]]],
      ],
      false,
    ];
    const chunk = JSON.stringify([
      [
        "wrb.fr",
        "jSf9Qc",
        JSON.stringify(payload),
        null,
        null,
        null,
        "generic",
      ],
    ]);
    const text = `)]}'
\n${chunk.length}\n${chunk}`;
    const results = parseBatchExecute(text);
    expect(results).toHaveLength(1);
    expect(results[0].rpcId).toBe("jSf9Qc");
    expect(results[0].payload).toEqual(payload);
  });
});

describe("parseJSf9Qc", () => {
  it("returns null for invalid payload", () => {
    expect(parseJSf9Qc(null, NOW)).toBeNull();
    expect(parseJSf9Qc([], NOW)).toBeNull();
    expect(parseJSf9Qc([2, [], false], NOW)).toBeNull();
  });

  it("parses Flash and Pro quota buckets", () => {
    // field[1] is the consumed fraction: 0.0 = nothing used, 0.36 = 36% used
    const payload = [
      2,
      [
        [2400, 0.0, 1, [[1779588120, 0]]],
        [30943, 0.36, 2, [[1779778920, 0]]],
      ],
      false,
    ];
    const snap = parseJSf9Qc(payload, NOW);
    expect(snap).not.toBeNull();
    expect(snap!.source).toBe("gemini-web");
    expect(snap!.subModels).toHaveLength(2);

    const flash = snap!.subModels!.find((m) => m.name === "session quota")!;
    expect(flash.limit).toBe(2400);
    expect(flash.used).toBe(0);
    expect(flash.pct).toBeCloseTo(0, 0);
    expect(flash.resetsAt).toBe(new Date(1779588120 * 1000).toISOString());

    const pro = snap!.subModels!.find((m) => m.name === "weekly quota")!;
    expect(pro.limit).toBe(30943);
    expect(pro.pct).toBeCloseTo(36, 0);
    expect(pro.resetsAt).toBe(new Date(1779778920 * 1000).toISOString());
  });
});
