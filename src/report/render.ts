import type { SourceId } from "../types.js";
import type {
  Cycle,
  ReportData,
  Series,
  SeriesPoint,
  SourceReport,
} from "./aggregate.js";

/** Most recent refresh rows rendered per bucket. The cap is always stated. */
export const MAX_LOG_ROWS = 200;
/** Cycle rows per bucket. Also stated when it bites. */
export const MAX_CYCLE_ROWS = 60;

const SOURCE_LABELS: Record<SourceId, string> = {
  "claude-code": "Claude Code",
  "gemini-cli": "Gemini CLI",
  "gemini-web": "Gemini Web",
  antigravity: "Antigravity",
};

const GEOM = { w: 1000, h: 210, padL: 46, padR: 16, padT: 14, padB: 34 };
const PLOT_W = GEOM.w - GEOM.padL - GEOM.padR;
const PLOT_H = GEOM.h - GEOM.padT - GEOM.padB;

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON safe to sit inside a <script> element. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtFull(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtReset(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : fmtTime(t);
}

/** "3h 12m" — how long until the quota comes back. */
function fmtUntil(iso: string | undefined, from: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const ms = t - from;
  if (ms <= 0) return "已重置";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `还剩 ${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `还剩 ${h}h ${mins % 60}m`;
  return `还剩 ${Math.floor(h / 24)}d ${h % 24}h`;
}

type Tier = "good" | "warning" | "critical";

/**
 * Three tiers, not four. The `serious` step of the status palette sits within
 * ΔE 13.6 of `warning` for normal vision — two adjacent severities a reader is
 * meant to compare should not be that close. Dropping it clears every
 * separation gate in both themes.
 */
function tierOf(pct: number): { tier: Tier; label: string } {
  if (pct >= 90) return { tier: "critical", label: "接近上限" };
  if (pct >= 70) return { tier: "warning", label: "偏紧" };
  return { tier: "good", label: "充足" };
}

function seriesTitle(s: Series): string {
  if (s.kind === "session") return "会话配额";
  if (s.kind === "weekly") return "周配额";
  return s.label;
}

// ---------------------------------------------------------------- chart ----

interface Domain {
  t0: number;
  t1: number;
}

function xOf(t: number, d: Domain): number {
  const span = d.t1 - d.t0 || 1;
  return GEOM.padL + ((t - d.t0) / span) * PLOT_W;
}

function yOf(pct: number): number {
  const clamped = Math.max(0, Math.min(100, pct));
  return GEOM.padT + (1 - clamped / 100) * PLOT_H;
}

/**
 * Step-after path: a reading holds until the next one replaces it, so the line
 * runs flat then jumps. Interpolating between samples would invent usage that
 * was never observed.
 */
function stepPath(points: SeriesPoint[], d: Domain): string {
  if (points.length === 0) return "";
  const parts = [`M${xOf(points[0].t, d).toFixed(2)},${yOf(points[0].pct).toFixed(2)}`];
  for (let i = 1; i < points.length; i++) {
    const x = xOf(points[i].t, d).toFixed(2);
    parts.push(`L${x},${yOf(points[i - 1].pct).toFixed(2)}`);
    parts.push(`L${x},${yOf(points[i].pct).toFixed(2)}`);
  }
  return parts.join("");
}

function xTicks(d: Domain): string {
  const n = 5;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = d.t0 + ((d.t1 - d.t0) * i) / (n - 1);
    const x = xOf(t, d);
    const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    out.push(
      `<text class="tick" x="${x.toFixed(1)}" y="${GEOM.h - 12}" text-anchor="${anchor}">${esc(fmtTime(t))}</text>`,
    );
  }
  return out.join("");
}

function chartSvg(s: Series, d: Domain, outages: SourceReport["outages"]): string {
  const pts = s.points;
  if (pts.length === 0) return "";

  const grid = [0, 25, 50, 75, 100]
    .map((p) => {
      const y = yOf(p).toFixed(1);
      return (
        `<line class="grid" x1="${GEOM.padL}" y1="${y}" x2="${GEOM.padL + PLOT_W}" y2="${y}" />` +
        `<text class="tick" x="${GEOM.padL - 8}" y="${y}" dy="3" text-anchor="end">${p}</text>`
      );
    })
    .join("");

  const bands = outages
    .filter((o) => o.to >= d.t0 && o.from <= d.t1)
    .map((o) => {
      const x1 = xOf(Math.max(o.from, d.t0), d);
      const x2 = xOf(Math.min(o.to, d.t1), d);
      const w = Math.max(2, x2 - x1);
      return `<rect class="outage" x="${x1.toFixed(1)}" y="${GEOM.padT}" width="${w.toFixed(1)}" height="${PLOT_H}"><title>采集失败 ${esc(fmtTime(o.from))} — ${esc(fmtTime(o.to))}</title></rect>`;
    })
    .join("");

  // One hairline per observed reset, at the first reading of the new cycle.
  const resets = s.cycles
    .slice(1)
    .map((c) => {
      const x = xOf(c.startsAt, d).toFixed(1);
      return (
        `<line class="reset" x1="${x}" y1="${GEOM.padT - 4}" x2="${x}" y2="${GEOM.padT + PLOT_H}" />` +
        `<circle class="reset-dot" cx="${x}" cy="${GEOM.padT - 4}" r="2.5"><title>配额重置 ${esc(fmtFull(c.startsAt))}</title></circle>`
      );
    })
    .join("");

  const line = stepPath(pts, d);
  const baseY = yOf(0).toFixed(2);
  const area = `${line}L${xOf(pts[pts.length - 1].t, d).toFixed(2)},${baseY}L${xOf(pts[0].t, d).toFixed(2)},${baseY}Z`;

  const last = pts[pts.length - 1];
  const lx = xOf(last.t, d);
  const ly = yOf(last.pct);
  const labelLeft = lx > GEOM.padL + PLOT_W - 60;

  return `<svg class="chart" viewBox="0 0 ${GEOM.w} ${GEOM.h}" role="img" tabindex="0" aria-label="${esc(seriesTitle(s))}用量随时间变化，当前 ${num(last.pct)}%">
${grid}${bands}${resets}
<path class="area" d="${area}" />
<path class="line" d="${line}" />
<circle class="end-ring" cx="${lx.toFixed(2)}" cy="${ly.toFixed(2)}" r="4.5" />
<text class="end-label" x="${(labelLeft ? lx - 10 : lx + 10).toFixed(1)}" y="${ly.toFixed(1)}" dy="-10" text-anchor="${labelLeft ? "end" : "start"}">${num(last.pct)}%</text>
${xTicks(d)}
<line class="cursor" x1="0" y1="${GEOM.padT}" x2="0" y2="${GEOM.padT + PLOT_H}" />
<circle class="cursor-dot" cx="0" cy="0" r="4.5" />
<rect class="hit" x="${GEOM.padL}" y="${GEOM.padT}" width="${PLOT_W}" height="${PLOT_H}" />
</svg>`;
}

// --------------------------------------------------------------- tables ----

function cycleRows(s: Series): string {
  const shown = s.cycles.slice(-MAX_CYCLE_ROWS).reverse();
  return shown
    .map((c: Cycle) => {
      const t = tierOf(c.peakPct);
      return `<tr>
<td class="mono">${esc(fmtFull(c.startsAt))}</td>
<td class="mono">${esc(fmtFull(c.endsAt))}</td>
<td class="mono num"><span class="dot ${t.tier}" aria-hidden="true"></span>${num(c.peakPct)}%</td>
<td class="mono num">${num(c.finalUsed)}</td>
<td class="mono num">${num(c.finalRemaining)}</td>
<td class="mono">${esc(fmtReset(c.resetsAt))}</td>
</tr>`;
    })
    .join("");
}

function logRows(s: Series): string {
  return s.points
    .slice(-MAX_LOG_ROWS)
    .reverse()
    .map(
      (p) => `<tr>
<td class="mono">${esc(fmtFull(p.t))}</td>
<td class="mono num">${num(p.used)}</td>
<td class="mono num">${num(p.remaining)}</td>
<td class="mono num">${num(p.pct)}%</td>
<td class="mono">${esc(fmtReset(p.resetsAt))}</td>
</tr>`,
    )
    .join("");
}

function capNote(total: number, cap: number): string {
  return total > cap
    ? `<p class="cap">显示最近 ${cap} 条，共 ${total} 条。完整记录见 <code>~/.config/quotacheck-mcp/history/</code>。</p>`
    : "";
}

// ---------------------------------------------------------------- cards ----

/** Nothing was ever spent from this bucket in the window. */
function isQuiet(s: Series): boolean {
  return s.points.every((p) => p.pct === 0);
}

function bucketCard(s: Series, d: Domain, src: SourceReport, now: number): string {
  const last = s.latest!;
  const t = tierOf(last.pct);
  const until = fmtUntil(last.resetsAt, now);
  const quiet = isQuiet(s);

  // A flat line along zero costs a full plot's height to say "nothing happened".
  // Quiet buckets keep their readout and their tables, and drop the chart.
  return `<article class="bucket"${quiet ? ' data-quiet="true"' : ""}>
<header class="bucket-head">
  <div class="bucket-id">
    <h3>${esc(seriesTitle(s))}</h3>
    <span class="pill ${t.tier}"><span class="dot ${t.tier}" aria-hidden="true"></span>${esc(t.label)}</span>
  </div>
  <dl class="readout">
    <div><dt>已用</dt><dd class="mono strong">${num(last.pct)}%</dd></div>
    <div><dt>剩余</dt><dd class="mono">${num(last.remaining)} / ${num(last.limit)}</dd></div>
    <div><dt>下次重置</dt><dd class="mono">${esc(fmtReset(last.resetsAt))}${until ? ` <span class="soft">${esc(until)}</span>` : ""}</dd></div>
  </dl>
</header>
${quiet ? '<p class="quiet-note">整个区间内未使用。</p>' : `<div class="chart-wrap" data-series="${esc(s.key)}">
${chartSvg(s, d, src.outages)}
<div class="tip" role="status" aria-live="polite"></div>
</div>`}
<div class="tables">
<details>
<summary>配额周期 <span class="count">${s.cycles.length}</span></summary>
${capNote(s.cycles.length, MAX_CYCLE_ROWS)}
<div class="scroll"><table>
<thead><tr><th>周期开始</th><th>周期结束</th><th>峰值</th><th>期末已用</th><th>期末剩余</th><th>重置时间</th></tr></thead>
<tbody>${cycleRows(s)}</tbody>
</table></div>
</details>
<details>
<summary>刷新记录 <span class="count">${s.points.length}</span></summary>
${capNote(s.points.length, MAX_LOG_ROWS)}
<div class="scroll"><table>
<thead><tr><th>刷新时间</th><th>已用</th><th>剩余</th><th>占比</th><th>下次重置</th></tr></thead>
<tbody>${logRows(s)}</tbody>
</table></div>
</details>
</div>
</article>`;
}

function sourceSection(src: SourceReport, d: Domain, now: number): string {
  const present = src.series.filter((s) => s.latest);
  // Buckets with something to show lead; idle ones settle at the bottom.
  const buckets = [...present.filter((s) => !isQuiet(s)), ...present.filter(isQuiet)].map(
    (s) => bucketCard(s, d, src, now),
  );
  const failing = src.errorCount > 0;
  return `<section class="source" data-source="${esc(src.source)}">
<header class="source-head">
  <h2>${esc(SOURCE_LABELS[src.source] ?? src.source)}</h2>
  <p class="meta mono">${src.eventCount} 次采集${failing ? ` · <span class="warn">${src.errorCount} 次失败</span>` : ""}${src.lastCollectedAt ? ` · 最近 ${esc(fmtTime(src.lastCollectedAt))}` : ""}</p>
</header>
${buckets.length ? buckets.join("\n") : '<p class="empty-source">这段时间内只有失败的采集记录。</p>'}
</section>`;
}

function summaryTile(src: SourceReport, now: number): string {
  const worst = src.series
    .filter((s) => s.latest)
    .reduce<Series | null>((a, b) => (!a || b.latest!.pct > a.latest!.pct ? b : a), null);
  if (!worst) {
    return `<div class="tile"><p class="tile-label">${esc(SOURCE_LABELS[src.source] ?? src.source)}</p><p class="tile-value soft">无数据</p><p class="tile-sub mono">${src.errorCount} 次失败</p></div>`;
  }
  const last = worst.latest!;
  const t = tierOf(last.pct);
  return `<div class="tile">
<p class="tile-label">${esc(SOURCE_LABELS[src.source] ?? src.source)}</p>
<p class="tile-value">${num(last.pct)}<span class="unit">%</span></p>
<p class="tile-sub"><span class="dot ${t.tier}" aria-hidden="true"></span>${esc(t.label)} · ${esc(seriesTitle(worst))}</p>
<p class="tile-sub mono soft">${esc(fmtUntil(last.resetsAt, now) || "无重置时间")}</p>
</div>`;
}

// ----------------------------------------------------------------- page ----

function domainOf(data: ReportData): Domain {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const src of data.sources) {
    for (const s of src.series) {
      for (const p of s.points) {
        if (p.t < t0) t0 = p.t;
        if (p.t > t1) t1 = p.t;
      }
    }
  }
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return { t0: data.since, t1: data.until };
  return t0 === t1 ? { t0: t0 - 1800_000, t1: t1 + 1800_000 } : { t0, t1 };
}

export function renderReport(data: ReportData): string {
  const now = Date.parse(data.generatedAt);
  const d = domainOf(data);
  const hasData = data.sources.some((s) => s.series.some((x) => x.latest));

  const pointData: Record<string, Array<[number, number, number, number, string | null]>> = {};
  for (const src of data.sources) {
    for (const s of src.series) {
      pointData[s.key] = s.points.map((p) => [p.t, p.pct, p.used, p.remaining, p.resetsAt ?? null]);
    }
  }

  const body = hasData
    ? data.sources.map((s) => sourceSection(s, d, now)).join("\n")
    : `<section class="blank"><h2>还没有记录</h2><p>这段时间内没有采集到任何配额数据。菜单栏应用每 5 分钟刷新一次，跑一会儿再来看，或者手动执行一次 <code>npm run report</code> 之前先 <code>npx tsx scripts/export-json.ts --force</code>。</p></section>`;

  const chips = data.sources
    .map(
      (s) =>
        `<button type="button" class="chip" aria-pressed="true" data-filter="${esc(s.source)}">${esc(SOURCE_LABELS[s.source] ?? s.source)}</button>`,
    )
    .join("");

  return `<meta charset="utf-8">
<title>Quota Ledger</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface-1: #fcfcfb;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #898781;
  --grid: #e1e0d9;
  --baseline: #c3c2b7;
  --hairline: rgba(11, 11, 11, 0.10);
  --series-1: #2a78d6;
  --series-1-wash: rgba(42, 120, 214, 0.10);
  --good: #0ca30c;
  --warning: #fab219;
  --critical: #d03b3b;
  --tint: rgba(42, 120, 214, 0.06);
  --sans: "Archivo", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --step: 4px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface-1: #1a1a19;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --grid: #2c2c2a;
    --baseline: #383835;
    --hairline: rgba(255, 255, 255, 0.10);
    --series-1: #3987e5;
    --series-1-wash: rgba(57, 135, 229, 0.10);
    --tint: rgba(57, 135, 229, 0.08);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d;
  --surface-1: #1a1a19;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --text-muted: #898781;
  --grid: #2c2c2a;
  --baseline: #383835;
  --hairline: rgba(255, 255, 255, 0.10);
  --series-1: #3987e5;
  --series-1-wash: rgba(57, 135, 229, 0.10);
  --tint: rgba(57, 135, 229, 0.08);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page);
  color: var(--text-primary);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap {
  max-width: 1120px;
  margin: 0 auto;
  padding: 48px 24px 96px;
  display: flex;
  flex-direction: column;
  gap: 40px;
}
h1, h2, h3 { text-wrap: balance; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: 28px; letter-spacing: -0.02em; }
h2 { font-size: 19px; }
h3 { font-size: 15px; }
p { margin: 0; }
code {
  font-family: var(--mono);
  font-size: 0.88em;
  background: var(--tint);
  padding: 1px 5px;
  border-radius: 3px;
}
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.soft { color: var(--text-muted); }
.strong { font-weight: 500; }
.warn { color: var(--text-secondary); }

/* masthead */
.masthead { display: flex; flex-direction: column; gap: 6px; }
.eyebrow {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--text-muted);
  font-weight: 600;
}
.masthead .meta { color: var(--text-secondary); font-size: 13px; }

/* filter row — one row, above everything it scopes */
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding-bottom: 4px;
}
.chip, .ghost {
  font: inherit;
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--surface-1);
  border: 1px solid var(--hairline);
  border-radius: 999px;
  padding: 5px 13px;
  cursor: pointer;
}
.chip[aria-pressed="true"] {
  color: var(--text-primary);
  border-color: var(--baseline);
  background: var(--tint);
}
.chip[aria-pressed="false"] { opacity: 0.55; text-decoration: line-through; }
.ghost { border-radius: 6px; margin-left: auto; }
.chip:hover, .ghost:hover { border-color: var(--baseline); }
:is(button, summary, svg, a):focus-visible {
  outline: 2px solid var(--series-1);
  outline-offset: 2px;
  border-radius: 4px;
}

/* summary tiles */
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.tile {
  background: var(--surface-1);
  border: 1px solid var(--hairline);
  border-radius: 10px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tile-label { font-size: 12px; color: var(--text-secondary); font-weight: 500; }
.tile-value { font-size: 34px; line-height: 1.1; font-weight: 600; letter-spacing: -0.02em; }
.tile-value .unit { font-size: 16px; color: var(--text-muted); margin-left: 1px; }
.tile-sub { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }

/* dots & pills — colour never carries state alone; a label always rides along */
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.dot.good { background: var(--good); }
.dot.warning { background: var(--warning); }
.dot.critical { background: var(--critical); }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  border: 1px solid var(--hairline);
  border-radius: 999px;
  padding: 2px 10px 2px 8px;
  white-space: nowrap;
}

/* sections */
.source { display: flex; flex-direction: column; gap: 14px; }
.source[hidden] { display: none; }
.source-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.source-head .meta { font-size: 12px; color: var(--text-muted); }
.empty-source { font-size: 13px; color: var(--text-muted); }

.bucket {
  background: var(--surface-1);
  border: 1px solid var(--hairline);
  border-radius: 12px;
  padding: 18px 20px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.bucket[data-quiet] { padding: 14px 20px 10px; gap: 8px; }
.quiet-note { font-size: 12px; color: var(--text-muted); }
.bucket-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.bucket-id { display: flex; align-items: center; gap: 10px; }
.readout { display: flex; gap: 26px; margin: 0; flex-wrap: wrap; }
.readout div { display: flex; flex-direction: column; gap: 1px; }
.readout dt {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  font-weight: 600;
}
.readout dd { margin: 0; font-size: 14px; color: var(--text-primary); }

/* chart */
.chart-wrap { position: relative; }
.chart { display: block; width: 100%; height: auto; overflow: visible; }
.grid, .reset { stroke: var(--grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
.reset { stroke: var(--baseline); }
.reset-dot { fill: var(--baseline); }
.outage { fill: var(--text-muted); opacity: 0.14; }
.tick { fill: var(--text-muted); font-family: var(--mono); font-size: 10px; }
.area { fill: var(--series-1-wash); stroke: none; }
.line {
  fill: none;
  stroke: var(--series-1);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.end-ring {
  fill: var(--series-1);
  stroke: var(--surface-1);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.end-label {
  fill: var(--text-primary);
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 500;
  /* Surface halo so the value stays legible where it crosses its own curve. */
  paint-order: stroke fill;
  stroke: var(--surface-1);
  stroke-width: 3px;
  stroke-linejoin: round;
}
.cursor {
  stroke: var(--text-muted);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  opacity: 0;
}
.cursor-dot {
  fill: var(--series-1);
  stroke: var(--surface-1);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
  opacity: 0;
}
.chart-wrap.live .cursor, .chart-wrap.live .cursor-dot { opacity: 1; }
.hit { fill: transparent; }
.tip {
  position: absolute;
  top: 0;
  left: 0;
  transform: translate(-50%, -100%);
  background: var(--surface-1);
  border: 1px solid var(--baseline);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.1s ease;
  white-space: nowrap;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.10);
  z-index: 2;
}
.chart-wrap.live .tip { opacity: 1; }
.tip b { font-weight: 500; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.tip .tip-time { color: var(--text-muted); font-family: var(--mono); font-size: 11px; }
.tip .key {
  display: inline-block;
  width: 10px;
  height: 2px;
  background: var(--series-1);
  vertical-align: middle;
  margin-right: 6px;
}

/* tables */
.tables { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--hairline); padding-top: 10px; }
details summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 3px 0;
  list-style-position: inside;
}
details summary::marker { color: var(--text-muted); }
.count {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  background: var(--tint);
  padding: 0 5px;
  border-radius: 3px;
  margin-left: 2px;
}
.cap { font-size: 11px; color: var(--text-muted); padding: 6px 0 0; }
.scroll { overflow-x: auto; max-height: 340px; overflow-y: auto; margin-top: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { text-align: left; padding: 5px 12px 5px 0; white-space: nowrap; }
th {
  position: sticky;
  top: 0;
  background: var(--surface-1);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  font-weight: 600;
  border-bottom: 1px solid var(--hairline);
}
td { color: var(--text-secondary); border-bottom: 1px solid var(--hairline); }
td.num { text-align: right; padding-right: 20px; }
td .dot { margin-right: 6px; }

.blank { color: var(--text-secondary); display: flex; flex-direction: column; gap: 8px; max-width: 62ch; }
footer { font-size: 12px; color: var(--text-muted); border-top: 1px solid var(--hairline); padding-top: 16px; }

@media (max-width: 640px) {
  .wrap { padding: 32px 16px 64px; gap: 28px; }
  .readout { gap: 18px; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
</style>

<div class="wrap">
<header class="masthead">
  <p class="eyebrow">Quotacheck</p>
  <h1>配额使用记录</h1>
  <p class="meta mono">${esc(fmtFull(d.t0))} — ${esc(fmtFull(d.t1))} · 最近 ${data.days} 天 · ${data.totalEvents} 条采集记录 · 生成于 ${esc(fmtFull(now))}</p>
</header>

<div class="filters">${chips}<button type="button" class="ghost" id="toggle-all">展开全部明细</button></div>

<div class="tiles">${data.sources.map((s) => summaryTile(s, now)).join("")}</div>

${body}

<footer>每条曲线是阶梯线：一次读数保持到下一次读数为止，两次采集之间不插值。竖线标记观测到的配额重置，灰带表示采集失败的时段。原始记录保存在 <code>~/.config/quotacheck-mcp/history/</code>。</footer>
</div>

<script type="application/json" id="qc-points">${jsonForScript(pointData)}</script>
<script>
(function () {
  var el = document.getElementById("qc-points");
  var PTS = el ? JSON.parse(el.textContent) : {};
  var DOM0 = ${d.t0}, DOM1 = ${d.t1};
  var PAD_L = ${GEOM.padL}, PLOT_W = ${PLOT_W}, VB_W = ${GEOM.w};

  function pad(n) { return String(n).padStart(2, "0"); }
  function fmt(t) {
    var d = new Date(t);
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function num(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }

  document.querySelectorAll(".chart-wrap").forEach(function (wrap) {
    var pts = PTS[wrap.dataset.series];
    if (!pts || !pts.length) return;
    var svg = wrap.querySelector("svg");
    var cursor = wrap.querySelector(".cursor");
    var dot = wrap.querySelector(".cursor-dot");
    var tip = wrap.querySelector(".tip");
    var idx = -1;

    function xOf(t) { return PAD_L + ((t - DOM0) / (DOM1 - DOM0 || 1)) * PLOT_W; }
    function yOf(p) { return ${GEOM.padT} + (1 - Math.max(0, Math.min(100, p)) / 100) * ${PLOT_H}; }

    function show(i) {
      if (i < 0 || i >= pts.length) return;
      idx = i;
      var p = pts[i];
      var vx = xOf(p[0]), vy = yOf(p[1]);
      cursor.setAttribute("x1", vx); cursor.setAttribute("x2", vx);
      dot.setAttribute("cx", vx); dot.setAttribute("cy", vy);

      // Untrusted-by-default: build the tooltip from nodes, never innerHTML.
      tip.textContent = "";
      var time = document.createElement("div");
      time.className = "tip-time";
      time.textContent = fmt(p[0]);
      var val = document.createElement("div");
      var key = document.createElement("span");
      key.className = "key";
      val.appendChild(key);
      var strong = document.createElement("b");
      strong.textContent = num(p[1]) + "%";
      val.appendChild(strong);
      val.appendChild(document.createTextNode(" 已用 · 剩余 " + num(p[3])));
      tip.appendChild(time);
      tip.appendChild(val);
      if (p[4]) {
        var r = document.createElement("div");
        r.className = "tip-time";
        r.textContent = "重置于 " + fmt(Date.parse(p[4]));
        tip.appendChild(r);
      }

      var rect = svg.getBoundingClientRect();
      var scale = rect.width / VB_W;
      tip.style.left = Math.max(60, Math.min(rect.width - 60, vx * scale)) + "px";
      tip.style.top = (vy * (rect.height / ${GEOM.h})) - 10 + "px";
      wrap.classList.add("live");
    }

    function nearest(clientX) {
      var rect = svg.getBoundingClientRect();
      var t = DOM0 + (((clientX - rect.left) / rect.width * VB_W - PAD_L) / PLOT_W) * (DOM1 - DOM0);
      var best = 0, bestD = Infinity;
      for (var i = 0; i < pts.length; i++) {
        var d = Math.abs(pts[i][0] - t);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    function hide() { wrap.classList.remove("live"); }

    svg.addEventListener("pointermove", function (e) { show(nearest(e.clientX)); });
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("blur", hide);
    svg.addEventListener("focus", function () { show(idx < 0 ? pts.length - 1 : idx); });
    svg.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { show(Math.max(0, idx - 1)); e.preventDefault(); }
      else if (e.key === "ArrowRight") { show(Math.min(pts.length - 1, idx + 1)); e.preventDefault(); }
      else if (e.key === "Escape") { hide(); }
    });
  });

  document.querySelectorAll(".chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      var on = chip.getAttribute("aria-pressed") !== "true";
      chip.setAttribute("aria-pressed", String(on));
      document.querySelectorAll('.source[data-source="' + chip.dataset.filter + '"]').forEach(function (s) {
        s.hidden = !on;
      });
    });
  });

  var toggle = document.getElementById("toggle-all");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var all = Array.prototype.slice.call(document.querySelectorAll("details"));
      var open = all.some(function (d) { return !d.open; });
      all.forEach(function (d) { d.open = open; });
      toggle.textContent = open ? "收起全部明细" : "展开全部明细";
    });
  }
})();
</script>`;
}
