import { describe, it, expect } from "vitest";
import { buildReport } from "../../src/report/aggregate.js";
import { renderReport, MAX_LOG_ROWS } from "../../src/report/render.js";
import type { QuotaSnapshot } from "../../src/types.js";

const T0 = Date.parse("2026-08-01T00:00:00.000Z");
const HOUR = 3_600_000;

function html(snaps: QuotaSnapshot[]) {
  return renderReport(
    buildReport(snaps, {
      since: new Date(T0),
      until: new Date(T0 + 500 * HOUR),
      days: 7,
      generatedAt: new Date(T0 + 500 * HOUR),
    }),
  );
}

/** The page renders from this; asserting on it beats asserting on markup. */
function payloadOf(out: string): any {
  const open = '<script type="application/json" id="qc-data">';
  const start = out.indexOf(open) + open.length;
  const end = out.indexOf("</script>", start);
  return JSON.parse(out.slice(start, end));
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
    expect(out).not.toMatch(/<!doctype/i);
    expect(out).not.toMatch(/<html[\s>]/i);
    expect(out).not.toMatch(/<body[\s>]/i);
    expect(out).toMatch(/<title>/);
  });

  it("declares utf-8 within the first 1024 bytes", () => {
    expect(html(sample).slice(0, 1024)).toContain('<meta charset="utf-8">');
  });

  it("contacts no host other than Google Fonts", () => {
    const urls = html(sample).match(/https?:\/\/[^"'\s)]+/g) ?? [];
    const hosts = [...new Set(urls.map((u) => new URL(u).host))];
    expect(hosts.every((h) => h.endsWith("fonts.googleapis.com") || h.endsWith("fonts.gstatic.com"))).toBe(true);
  });

  it("defines every colour token on bare :root, not only inside a theme block", () => {
    const out = html(sample);
    const root = out.slice(out.indexOf(":root {"), out.indexOf("@media"));
    for (const token of ["--surface-1", "--text-primary", "--series-1", "--page"]) {
      expect(root).toContain(token);
    }
  });

  it("tells the reader when JavaScript is required", () => {
    expect(html(sample)).toContain("<noscript>");
  });

  it("embeds one series per quota bucket with its full point list", () => {
    const p = payloadOf(html(sample));
    expect(p.sources).toHaveLength(1);
    expect(p.sources[0].series.map((s: any) => s.kind)).toEqual(["session", "weekly"]);
    expect(p.sources[0].series[0].pts).toHaveLength(2);
  });

  it("embeds points uncapped so the range picker can zoom to full detail", () => {
    const many: QuotaSnapshot[] = Array.from({ length: 1500 }, (_, i) => ({
      source: "claude-code",
      collectedAt: new Date(T0 + i * 60_000).toISOString(),
      session: { used: i % 90, limit: 100, pct: i % 90 },
    }));
    const out = renderReport(
      buildReport(many, {
        since: new Date(T0),
        until: new Date(T0 + 500 * HOUR),
        days: 30,
        maxPoints: 50,
        generatedAt: new Date(T0 + 500 * HOUR),
      }),
    );
    const p = payloadOf(out);
    expect(p.sources[0].series[0].pts.length).toBeGreaterThan(1000);
    // The cap travels to the page as a drawing budget instead.
    expect(p.maxPoints).toBe(50);
  });

  it("ships each series' group to the page for overview tiles", () => {
    const out = html([
      {
        source: "antigravity",
        collectedAt: new Date(T0).toISOString(),
        subModels: [
          { name: "Gemini Models · Weekly", group: "Gemini Models", used: 44, limit: 100, pct: 44 },
          { name: "Claude and GPT models · Weekly", group: "Claude and GPT models", used: 0, limit: 100, pct: 0 },
        ],
      },
    ]);
    const groups = payloadOf(out).sources[0].series.map((s: any) => s.group);
    expect(new Set(groups)).toEqual(new Set(["Gemini Models", "Claude and GPT models"]));
  });

  it("hands the page its log cap rather than truncating server-side", () => {
    expect(payloadOf(html(sample)).logCap).toBe(MAX_LOG_ROWS);
  });

  it("embeds cycles without their point arrays", () => {
    const p = payloadOf(html(sample));
    const cycles = p.sources[0].series[0].cycles;
    expect(cycles.length).toBeGreaterThan(0);
    // Arrays of summary fields — a nested point list would double the file.
    expect(Array.isArray(cycles[0])).toBe(true);
    expect(JSON.stringify(cycles)).not.toContain("remaining");
  });

  it("cannot be broken out of by hostile collector output", () => {
    const nasty = '</script><script>alert(1)</script>';
    const out = html([
      {
        source: "antigravity",
        collectedAt: new Date(T0).toISOString(),
        subModels: [{ name: nasty, used: 1, limit: 100, pct: 1 }],
      },
      { source: "gemini-web", collectedAt: new Date(T0).toISOString(), error: nasty },
    ]);
    // No raw angle brackets survive into the document...
    expect(out).not.toContain("<script>alert(1)");
    expect(out).not.toContain("</script><script>");
    // ...yet the value round-trips intact for the page to set via textContent.
    const p = payloadOf(out);
    const names = p.sources.flatMap((s: any) => s.series.map((x: any) => x.label));
    expect(names).toContain(nasty);
    expect(p.sources.find((s: any) => s.id === "gemini-web").outages[0][2]).toBe(nasty);
  });

  it("labels a codex source with its display name", () => {
    // Unlabelled sources fall back to the raw id; "codex" would read as a
    // lowercase slug next to "Claude Code".
    const payload = payloadOf(
      html([
        {
          source: "codex",
          collectedAt: new Date(T0).toISOString(),
          session: { used: 31, limit: 100, pct: 31 },
          weekly: { used: 5, limit: 100, pct: 5 },
        },
      ]),
    );
    expect(payload.sources.find((s: any) => s.id === "codex").label).toBe(
      "Codex",
    );
  });

  it("renders an empty state rather than a blank page", () => {
    const out = html([]);
    expect(out).toMatch(/还没有/);
    expect(out).not.toContain('id="sources"');
  });
});
