import { describe, it, expect } from "vitest";
import { buildReport } from "../../src/report/aggregate.js";
import { renderReport, MAX_LOG_ROWS } from "../../src/report/render.js";
import type { QuotaSnapshot } from "../../src/types.js";

const T0 = Date.parse("2026-08-01T00:00:00.000Z");
const HOUR = 3_600_000;

function build(snaps: QuotaSnapshot[]) {
  return buildReport(snaps, {
    since: new Date(T0),
    until: new Date(T0 + 500 * HOUR),
    days: 7,
    generatedAt: new Date(T0 + 500 * HOUR),
  });
}

function html(snaps: QuotaSnapshot[]) {
  return renderReport(build(snaps));
}

const sample: QuotaSnapshot[] = [
  {
    source: "claude-code",
    collectedAt: new Date(T0).toISOString(),
    session: { used: 10, limit: 100, pct: 10, resetsAt: new Date(T0 + 5 * HOUR).toISOString() },
    weekly: { used: 40, limit: 100, pct: 40 },
  },
  {
    source: "claude-code",
    collectedAt: new Date(T0 + HOUR).toISOString(),
    session: { used: 93, limit: 100, pct: 93, resetsAt: new Date(T0 + 5 * HOUR).toISOString() },
    weekly: { used: 44, limit: 100, pct: 44 },
  },
];

describe("renderReport", () => {
  it("emits a page fragment with no document skeleton", () => {
    const out = html(sample);
    // Artifact wraps the file in its own skeleton; a browser opening the file
    // directly builds one too. Emitting our own would nest them.
    expect(out).not.toMatch(/<!doctype/i);
    expect(out).not.toMatch(/<html[\s>]/i);
    expect(out).not.toMatch(/<body[\s>]/i);
    expect(out).toMatch(/<title>/);
  });

  it("declares utf-8 within the first 1024 bytes", () => {
    // The page is full of Chinese labels; without this the file mojibakes when
    // opened directly, and the browser only scans the head of the stream.
    const out = html(sample);
    expect(out.slice(0, 1024)).toContain('<meta charset="utf-8">');
  });

  it("renders a card per quota bucket", () => {
    const out = html(sample);
    expect(out).toContain("claude-code");
    expect(out.match(/class="bucket"/g) ?? []).toHaveLength(2);
  });

  it("escapes hostile text coming from collector output", () => {
    const out = html([
      {
        source: "antigravity",
        collectedAt: new Date(T0).toISOString(),
        subModels: [
          { name: '<img src=x onerror="alert(1)">', used: 1, limit: 100, pct: 1 },
        ],
      },
      {
        source: "gemini-web",
        collectedAt: new Date(T0).toISOString(),
        error: "</script><script>alert(2)</script>",
      },
    ]);
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<script>alert(2)");
    expect(out).not.toContain("</script><script>");
    expect(out).toContain("&lt;img src=x");
  });

  it("gives a never-used bucket a compact row instead of an empty chart, and sorts it last", () => {
    const out = html([
      {
        source: "gemini-web",
        collectedAt: new Date(T0).toISOString(),
        subModels: [
          { name: "AAA Idle", used: 0, limit: 100, pct: 0 },
          { name: "ZZZ Busy", used: 30, limit: 100, pct: 30 },
        ],
      },
      {
        source: "gemini-web",
        collectedAt: new Date(T0 + HOUR).toISOString(),
        subModels: [
          { name: "AAA Idle", used: 0, limit: 100, pct: 0 },
          { name: "ZZZ Busy", used: 55, limit: 100, pct: 55 },
        ],
      },
    ]);
    expect(out.match(/class="bucket"/g) ?? []).toHaveLength(2);
    expect(out.match(/<svg/g) ?? []).toHaveLength(1);
    // The bucket with something to show leads, despite sorting after alphabetically.
    expect(out.indexOf("ZZZ Busy")).toBeLessThan(out.indexOf("AAA Idle"));
    expect(out).toMatch(/未使用/);
  });

  it("contacts no host other than Google Fonts", () => {
    const urls = html(sample).match(/https?:\/\/[^"'\s)]+/g) ?? [];
    const hosts = [...new Set(urls.map((u) => new URL(u).host))];
    expect(hosts.every((h) => h.endsWith("fonts.googleapis.com") || h.endsWith("fonts.gstatic.com"))).toBe(true);
  });

  it("states the cap instead of silently truncating a long refresh log", () => {
    const many: QuotaSnapshot[] = Array.from({ length: MAX_LOG_ROWS + 40 }, (_, i) => ({
      source: "claude-code",
      collectedAt: new Date(T0 + i * HOUR).toISOString(),
      session: { used: i % 90, limit: 100, pct: i % 90 },
    }));
    const out = renderReport(
      buildReport(many, {
        since: new Date(T0),
        until: new Date(T0 + 10_000 * HOUR),
        days: 90,
        maxPoints: 10_000,
        generatedAt: new Date(T0),
      }),
    );
    expect(out).toContain(String(MAX_LOG_ROWS));
    expect(out).toMatch(/最近/);
  });

  it("renders an empty state rather than a blank page", () => {
    const out = html([]);
    expect(out).toMatch(/还没有/);
    expect(out).not.toContain('class="bucket"');
  });

  it("defines every colour token on bare :root, not only inside a theme block", () => {
    const out = html(sample);
    const root = out.slice(out.indexOf(":root {"), out.indexOf("@media"));
    for (const token of ["--surface-1", "--text-primary", "--series-1", "--page"]) {
      expect(root).toContain(token);
    }
  });
});
