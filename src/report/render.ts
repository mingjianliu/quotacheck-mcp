import type { SourceId } from "../types.js";
import type { ReportData, Series, SourceReport } from "./aggregate.js";

/** Most recent refresh rows rendered per bucket. The cap is always stated. */
export const MAX_LOG_ROWS = 200;

const SOURCE_LABELS: Record<SourceId, string> = {
  "claude-code": "Claude Code",
  "gemini-web": "Gemini Web",
  antigravity: "Antigravity",
  codex: "Codex",
};

/** JSON safe to sit inside a <script> element. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtFull(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The payload the page renders from.
 *
 * Points are run-collapsed but uncapped, so the picker can zoom to full detail;
 * capping happens at draw time against whatever range is visible. Cycles carry
 * summary fields only — their point lists would duplicate the series and double
 * the file for nothing.
 */
function payload(data: ReportData) {
  return {
    generatedAt: Date.parse(data.generatedAt),
    since: data.since,
    until: data.until,
    days: data.days,
    maxPoints: data.maxPoints,
    totalEvents: data.totalEvents,
    logCap: MAX_LOG_ROWS,
    sources: data.sources.map((src: SourceReport) => ({
      id: src.source,
      label: SOURCE_LABELS[src.source] ?? src.source,
      eventCount: src.eventCount,
      errorCount: src.errorCount,
      outages: src.outages.map((o) => [o.from, o.to, o.error]),
      series: src.series
        .filter((s: Series) => s.latest)
        .map((s: Series) => ({
          key: s.key,
          kind: s.kind,
          label: s.label,
          group: s.group,
          pts: s.points.map((p) => [p.t, p.pct, p.used, p.remaining, p.resetsAt ?? null]),
          cycles: s.cycles.map((c) => [
            c.startsAt,
            c.endsAt,
            c.resetsAt ?? null,
            c.peakPct,
            c.finalUsed,
            c.finalRemaining,
          ]),
        })),
    })),
  };
}

export function renderReport(data: ReportData): string {
  const hasData = data.sources.some((s) => s.series.some((x) => x.latest));

  const body = hasData
    ? `<div class="filters" id="filters"></div>
<div class="tiles" id="tiles"></div>
<div id="sources"></div>`
    : `<section class="blank"><h2>还没有记录</h2><p>这段时间内没有采集到任何配额数据。菜单栏应用每 5 分钟刷新一次，跑一会儿再来看，或者先手动执行一次 <code>npx tsx scripts/export-json.ts --force</code>。</p></section>`;

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
  gap: 36px;
}
h1, h2, h3 { text-wrap: balance; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: 28px; letter-spacing: -0.02em; }
h2 { font-size: 19px; }
h3 { font-size: 15px; }
p { margin: 0; }
code { font-family: var(--mono); font-size: 0.88em; background: var(--tint); padding: 1px 5px; border-radius: 3px; }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.soft { color: var(--text-muted); }
.strong { font-weight: 500; }

.masthead { display: flex; flex-direction: column; gap: 6px; }
.eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--text-muted); font-weight: 600; }
.masthead .meta { color: var(--text-secondary); font-size: 13px; }

.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.chip, .ghost, .range-btn {
  font: inherit; font-size: 13px; color: var(--text-secondary);
  background: var(--surface-1); border: 1px solid var(--hairline);
  border-radius: 999px; padding: 5px 13px; cursor: pointer;
}
.chip[aria-pressed="true"] { color: var(--text-primary); border-color: var(--baseline); background: var(--tint); }
.chip[aria-pressed="false"] { opacity: 0.55; text-decoration: line-through; }
.ghost { border-radius: 6px; }
.chip:hover, .ghost:hover, .range-btn:hover { border-color: var(--baseline); }
:is(button, summary, svg, a, input):focus-visible { outline: 2px solid var(--series-1); outline-offset: 2px; border-radius: 4px; }

/* range picker */
.range { position: relative; margin-right: 4px; }
.range > summary { list-style: none; cursor: pointer; }
.range > summary::-webkit-details-marker { display: none; }
.range-btn {
  border-radius: 6px; display: inline-flex; align-items: center; gap: 8px;
  color: var(--text-primary); border-color: var(--baseline);
}
.range-btn .cal { color: var(--text-muted); font-size: 11px; }
.range-btn .caret { color: var(--text-muted); font-size: 9px; }
.range-menu {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 10; min-width: 250px;
  background: var(--surface-1); border: 1px solid var(--baseline); border-radius: 10px;
  padding: 6px; box-shadow: 0 8px 28px rgba(0,0,0,0.14);
  display: flex; flex-direction: column; gap: 1px;
}
.preset {
  font: inherit; font-size: 13px; text-align: left; width: 100%;
  background: none; border: 0; border-radius: 6px; padding: 6px 10px;
  color: var(--text-secondary); cursor: pointer;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
}
.preset:hover { background: var(--tint); }
.preset[aria-current="true"] { color: var(--text-primary); font-weight: 500; }
.preset .tick { color: var(--series-1); font-size: 13px; font-weight: 700; }
.abs { border-top: 1px solid var(--hairline); margin-top: 5px; padding: 10px 10px 6px; display: flex; flex-direction: column; gap: 8px; }
.abs label { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); }
.abs label span { width: 16px; color: var(--text-muted); }
.abs input {
  font: inherit; font-family: var(--mono); font-size: 12px; flex: 1;
  background: var(--page); color: var(--text-primary);
  border: 1px solid var(--hairline); border-radius: 5px; padding: 4px 7px;
}
.abs .row { display: flex; justify-content: flex-end; gap: 8px; align-items: center; }
.abs .err { color: var(--critical); font-size: 11px; margin-right: auto; }
.apply {
  font: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
  background: var(--series-1); color: #fff; border: 0; border-radius: 6px; padding: 5px 14px;
}

.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.tile { background: var(--surface-1); border: 1px solid var(--hairline); border-radius: 10px; padding: 16px 18px; display: flex; flex-direction: column; gap: 2px; }
.tile-label { font-size: 12px; color: var(--text-secondary); font-weight: 500; text-wrap: balance; }
.tile-value { font-size: 34px; line-height: 1.1; font-weight: 600; letter-spacing: -0.02em; }
.tile-value .unit { font-size: 16px; color: var(--text-muted); margin-left: 1px; }
.tile-sub { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }

.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.dot.good { background: var(--good); }
.dot.warning { background: var(--warning); }
.dot.critical { background: var(--critical); }
.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); border: 1px solid var(--hairline); border-radius: 999px; padding: 2px 10px 2px 8px; white-space: nowrap; }

#sources { display: flex; flex-direction: column; gap: 36px; }
.source { display: flex; flex-direction: column; gap: 14px; }
.source-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.source-head .meta { font-size: 12px; color: var(--text-muted); }
.empty-source { font-size: 13px; color: var(--text-muted); }

.bucket { background: var(--surface-1); border: 1px solid var(--hairline); border-radius: 12px; padding: 18px 20px 14px; display: flex; flex-direction: column; gap: 14px; }
.bucket[data-quiet] { padding: 14px 20px 10px; gap: 8px; }
.quiet-note { font-size: 12px; color: var(--text-muted); }
.bucket-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.bucket-id { display: flex; align-items: center; gap: 10px; }
.readout { display: flex; gap: 26px; margin: 0; flex-wrap: wrap; }
.readout div { display: flex; flex-direction: column; gap: 1px; }
.readout dt { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); font-weight: 600; }
.readout dd { margin: 0; font-size: 14px; color: var(--text-primary); }

.chart-wrap { position: relative; }
.chart { display: block; width: 100%; height: auto; overflow: visible; }
.grid, .reset { stroke: var(--grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
.reset { stroke: var(--baseline); }
.reset-dot { fill: var(--baseline); }
.outage { fill: var(--text-muted); opacity: 0.14; }
.tick { fill: var(--text-muted); font-family: var(--mono); font-size: 10px; }
.area { fill: var(--series-1-wash); stroke: none; }
.line { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.end-ring { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; vector-effect: non-scaling-stroke; }
.end-label {
  fill: var(--text-primary); font-family: var(--mono); font-size: 11px; font-weight: 500;
  paint-order: stroke fill; stroke: var(--surface-1); stroke-width: 3px; stroke-linejoin: round;
}
.cursor { stroke: var(--text-muted); stroke-width: 1; vector-effect: non-scaling-stroke; opacity: 0; }
.cursor-dot { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; vector-effect: non-scaling-stroke; opacity: 0; }
.chart-wrap.live .cursor, .chart-wrap.live .cursor-dot { opacity: 1; }
.hit { fill: transparent; }
.sampled { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.tip {
  position: absolute; top: 0; left: 0; transform: translate(-50%, -100%);
  background: var(--surface-1); border: 1px solid var(--baseline); border-radius: 8px;
  padding: 8px 10px; font-size: 12px; line-height: 1.5; pointer-events: none;
  opacity: 0; transition: opacity 0.1s ease; white-space: nowrap;
  box-shadow: 0 4px 14px rgba(0,0,0,0.10); z-index: 2;
}
.chart-wrap.live .tip { opacity: 1; }
.tip b { font-weight: 500; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.tip .tip-time { color: var(--text-muted); font-family: var(--mono); font-size: 11px; }
.tip .key { display: inline-block; width: 10px; height: 2px; background: var(--series-1); vertical-align: middle; margin-right: 6px; }

.tables { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--hairline); padding-top: 10px; }
details summary { cursor: pointer; font-size: 12px; color: var(--text-secondary); padding: 3px 0; list-style-position: inside; }
details summary::marker { color: var(--text-muted); }
.count { font-family: var(--mono); font-size: 11px; color: var(--text-muted); background: var(--tint); padding: 0 5px; border-radius: 3px; margin-left: 2px; }
.cap { font-size: 11px; color: var(--text-muted); padding: 6px 0 0; }
.scroll { overflow-x: auto; max-height: 340px; overflow-y: auto; margin-top: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { text-align: left; padding: 5px 12px 5px 0; white-space: nowrap; }
th { position: sticky; top: 0; background: var(--surface-1); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); font-weight: 600; border-bottom: 1px solid var(--hairline); }
td { color: var(--text-secondary); border-bottom: 1px solid var(--hairline); }
td.num { text-align: right; padding-right: 20px; }
td .dot { margin-right: 6px; }

.blank { color: var(--text-secondary); display: flex; flex-direction: column; gap: 8px; max-width: 62ch; }
footer { font-size: 12px; color: var(--text-muted); border-top: 1px solid var(--hairline); padding-top: 16px; }
.nojs { color: var(--critical); font-size: 13px; }

@media (max-width: 640px) {
  .wrap { padding: 32px 16px 64px; gap: 24px; }
  .readout { gap: 18px; }
  .range-menu { min-width: 220px; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style>

<div class="wrap">
<header class="masthead">
  <p class="eyebrow">Quotacheck</p>
  <h1>配额使用记录</h1>
  <p class="meta mono">生成于 ${fmtFull(Date.parse(data.generatedAt))} · 窗口 ${data.days} 天 · ${data.totalEvents} 条采集记录</p>
</header>

${body}

<footer>每条曲线是阶梯线：一次读数保持到下一次读数为止，两次采集之间不插值。竖线标记观测到的配额重置，灰带表示采集失败的时段。时间范围只能在生成窗口（${data.days} 天）内选择；要看更早的数据，用更大的 <code>--days</code> 重新生成。原始记录保存在 <code>~/.config/quotacheck-mcp/history/</code>。</footer>
</div>

<noscript><p class="nojs" style="max-width:1120px;margin:0 auto;padding:0 24px 48px">这份报表的图表和表格由页面脚本按所选时间范围渲染，需要启用 JavaScript。</p></noscript>

<script type="application/json" id="qc-data">${jsonForScript(payload(data))}</script>
<script>
(function () {
  var node = document.getElementById("qc-data");
  if (!node) return;
  var D = JSON.parse(node.textContent);
  var MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  function pad(n) { return String(n).padStart(2, "0"); }
  function fmt(t) {
    var d = new Date(t);
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fmtFull(t) {
    var d = new Date(t);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
      pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  function forInput(t) {
    var d = new Date(t);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" +
      pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function num(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }

  // Three tiers, never four: the palette's 'serious' step sits within
  // normal-vision deltaE 13.6 of 'warning' — too close for two adjacent
  // severities a reader is meant to compare.
  function tier(pct) {
    if (pct >= 90) return { cls: "critical", label: "接近上限" };
    if (pct >= 70) return { cls: "warning", label: "偏紧" };
    return { cls: "good", label: "充足" };
  }
  function seriesTitle(s) {
    if (s.kind === "session") return "会话配额";
    if (s.kind === "weekly") return "周配额";
    return s.label;
  }
  function untilText(iso, now) {
    if (!iso) return "";
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var ms = t - now;
    if (ms <= 0) return "已重置";
    var mins = Math.round(ms / 60000);
    if (mins < 60) return "还剩 " + mins + "m";
    var h = Math.floor(mins / 60);
    if (h < 48) return "还剩 " + h + "h " + (mins % 60) + "m";
    return "还剩 " + Math.floor(h / 24) + "d " + (h % 24) + "h";
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- data extent -------------------------------------------------------
  var dataMin = Infinity, dataMax = -Infinity;
  D.sources.forEach(function (src) {
    src.series.forEach(function (s) {
      if (s.pts.length) {
        if (s.pts[0][0] < dataMin) dataMin = s.pts[0][0];
        if (s.pts[s.pts.length - 1][0] > dataMax) dataMax = s.pts[s.pts.length - 1][0];
      }
    });
  });
  if (!isFinite(dataMin)) { dataMin = D.since; dataMax = D.until; }
  if (dataMin === dataMax) { dataMin -= 30 * MIN; dataMax += 30 * MIN; }

  var WINDOW = D.until - D.since;
  var PRESETS = [
    { ms: HOUR, label: "最近 1 小时" },
    { ms: 6 * HOUR, label: "最近 6 小时" },
    { ms: 24 * HOUR, label: "最近 24 小时" },
    { ms: 7 * DAY, label: "最近 7 天" },
    { ms: 30 * DAY, label: "最近 30 天" },
    { ms: 90 * DAY, label: "最近 90 天" }
  ].filter(function (p) { return p.ms <= WINDOW + MIN; });

  var state = { from: dataMin, to: dataMax, label: "全部数据", hidden: {} };

  // ---- geometry ----------------------------------------------------------
  var W = 1000, H = 210, PADL = 46, PADR = 16, PADT = 14, PADB = 34;
  var PW = W - PADL - PADR, PH = H - PADT - PADB;

  function xOf(t, a, b) { return PADL + ((t - a) / ((b - a) || 1)) * PW; }
  function yOf(p) { return PADT + (1 - Math.max(0, Math.min(100, p)) / 100) * PH; }

  /**
   * Thin to a drawing budget, keeping both endpoints and each bucket's peak.
   * Draw-time only — the embedded data stays complete, and the refresh log
   * below every chart still lists the real readings.
   */
  function capPts(pts, max) {
    var cap = Math.max(3, max);
    if (pts.length <= cap) return pts;
    var first = pts[0], last = pts[pts.length - 1];
    var buckets = cap - 2, span = (last[0] - first[0]) || 1;
    var picks = {};
    for (var i = 1; i < pts.length - 1; i++) {
      var p = pts[i];
      var idx = Math.min(buckets - 1, Math.floor(((p[0] - first[0]) / span) * buckets));
      if (!picks[idx] || p[1] > picks[idx][1]) picks[idx] = p;
    }
    var out = [first];
    Object.keys(picks).map(Number).sort(function (a, b) { return a - b; })
      .forEach(function (k) { out.push(picks[k]); });
    out.push(last);
    return out;
  }

  function inRange(pts, a, b) {
    return pts.filter(function (p) { return p[0] >= a && p[0] <= b; });
  }

  function chartSvg(pts, cycles, outages, a, b) {
    var i, parts = [];
    [0, 25, 50, 75, 100].forEach(function (p) {
      var y = yOf(p).toFixed(1);
      parts.push('<line class="grid" x1="' + PADL + '" y1="' + y + '" x2="' + (PADL + PW) + '" y2="' + y + '" />');
      parts.push('<text class="tick" x="' + (PADL - 8) + '" y="' + y + '" dy="3" text-anchor="end">' + p + "</text>");
    });

    outages.forEach(function (o) {
      if (o[1] < a || o[0] > b) return;
      var x1 = xOf(Math.max(o[0], a), a, b), x2 = xOf(Math.min(o[1], b), a, b);
      parts.push('<rect class="outage" x="' + x1.toFixed(1) + '" y="' + PADT + '" width="' +
        Math.max(2, x2 - x1).toFixed(1) + '" height="' + PH + '"><title></title></rect>');
    });

    // Every cycle after the first begins at an observed reset.
    cycles.forEach(function (c, idx) {
      if (idx === 0 || c[0] < a || c[0] > b) return;
      var x = xOf(c[0], a, b).toFixed(1);
      parts.push('<line class="reset" x1="' + x + '" y1="' + (PADT - 4) + '" x2="' + x + '" y2="' + (PADT + PH) + '" />');
      parts.push('<circle class="reset-dot" cx="' + x + '" cy="' + (PADT - 4) + '" r="2.5"><title>配额重置 ' + fmtFull(c[0]) + "</title></circle>");
    });

    var d = "M" + xOf(pts[0][0], a, b).toFixed(2) + "," + yOf(pts[0][1]).toFixed(2);
    for (i = 1; i < pts.length; i++) {
      var x = xOf(pts[i][0], a, b).toFixed(2);
      d += "L" + x + "," + yOf(pts[i - 1][1]).toFixed(2) + "L" + x + "," + yOf(pts[i][1]).toFixed(2);
    }
    var base = yOf(0).toFixed(2);
    parts.push('<path class="area" d="' + d + "L" + xOf(pts[pts.length - 1][0], a, b).toFixed(2) + "," + base +
      "L" + xOf(pts[0][0], a, b).toFixed(2) + "," + base + 'Z" />');
    parts.push('<path class="line" d="' + d + '" />');

    var last = pts[pts.length - 1];
    var lx = xOf(last[0], a, b), ly = yOf(last[1]);
    var left = lx > PADL + PW - 60;
    parts.push('<circle class="end-ring" cx="' + lx.toFixed(2) + '" cy="' + ly.toFixed(2) + '" r="4.5" />');
    parts.push('<text class="end-label" x="' + (left ? lx - 10 : lx + 10).toFixed(1) + '" y="' + ly.toFixed(1) +
      '" dy="-10" text-anchor="' + (left ? "end" : "start") + '">' + num(last[1]) + "%</text>");

    for (i = 0; i < 5; i++) {
      var t = a + ((b - a) * i) / 4;
      var anchor = i === 0 ? "start" : i === 4 ? "end" : "middle";
      parts.push('<text class="tick" x="' + xOf(t, a, b).toFixed(1) + '" y="' + (H - 12) + '" text-anchor="' + anchor + '">' + fmt(t) + "</text>");
    }

    parts.push('<line class="cursor" x1="0" y1="' + PADT + '" x2="0" y2="' + (PADT + PH) + '" />');
    parts.push('<circle class="cursor-dot" cx="0" cy="0" r="4.5" />');
    parts.push('<rect class="hit" x="' + PADL + '" y="' + PADT + '" width="' + PW + '" height="' + PH + '" />');

    return '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" tabindex="0">' + parts.join("") + "</svg>";
  }

  function attachHover(wrap, pts) {
    var svg = wrap.querySelector("svg");
    var cursor = wrap.querySelector(".cursor");
    var dot = wrap.querySelector(".cursor-dot");
    var tip = wrap.querySelector(".tip");
    var a = state.from, b = state.to, idx = -1;

    function show(i) {
      if (i < 0 || i >= pts.length) return;
      idx = i;
      var p = pts[i], vx = xOf(p[0], a, b), vy = yOf(p[1]);
      cursor.setAttribute("x1", vx); cursor.setAttribute("x2", vx);
      dot.setAttribute("cx", vx); dot.setAttribute("cy", vy);

      tip.textContent = "";
      tip.appendChild(el("div", "tip-time", fmt(p[0])));
      var row = el("div");
      row.appendChild(el("span", "key"));
      var strong = document.createElement("b");
      strong.textContent = num(p[1]) + "%";
      row.appendChild(strong);
      row.appendChild(document.createTextNode(" 已用 · 剩余 " + num(p[3])));
      tip.appendChild(row);
      if (p[4]) tip.appendChild(el("div", "tip-time", "重置于 " + fmt(Date.parse(p[4]))));

      var r = svg.getBoundingClientRect();
      tip.style.left = Math.max(64, Math.min(r.width - 64, vx * (r.width / W))) + "px";
      tip.style.top = (vy * (r.height / H) - 10) + "px";
      wrap.classList.add("live");
    }
    function nearest(clientX) {
      var r = svg.getBoundingClientRect();
      var t = a + (((clientX - r.left) / r.width * W - PADL) / PW) * (b - a);
      var best = 0, bd = Infinity;
      for (var i = 0; i < pts.length; i++) {
        var dd = Math.abs(pts[i][0] - t);
        if (dd < bd) { bd = dd; best = i; }
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
      else if (e.key === "Escape") hide();
    });
  }

  function tableBlock(summaryText, count, capNote, headers, rows) {
    var d = document.createElement("details");
    var sum = document.createElement("summary");
    sum.appendChild(document.createTextNode(summaryText + " "));
    sum.appendChild(el("span", "count", String(count)));
    d.appendChild(sum);
    if (capNote) d.appendChild(el("p", "cap", capNote));
    var scroll = el("div", "scroll");
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    headers.forEach(function (h) { htr.appendChild(el("th", null, h)); });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    rows.forEach(function (cells) {
      var tr = document.createElement("tr");
      cells.forEach(function (c) {
        var td = el("td", c.cls || "mono", null);
        if (c.dot) td.appendChild(el("span", "dot " + c.dot));
        td.appendChild(document.createTextNode(c.text));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    d.appendChild(scroll);
    return d;
  }

  function buildBucket(src, s) {
    var a = state.from, b = state.to;
    var pts = inRange(s.pts, a, b);
    var card = el("article", "bucket");
    if (!pts.length) {
      card.setAttribute("data-quiet", "true");
      var head0 = el("div", "bucket-head");
      var id0 = el("div", "bucket-id");
      id0.appendChild(el("h3", null, seriesTitle(s)));
      head0.appendChild(id0);
      card.appendChild(head0);
      card.appendChild(el("p", "quiet-note", "所选时间范围内没有这个配额的读数。"));
      return card;
    }

    var last = pts[pts.length - 1];
    var t = tier(last[1]);
    var quiet = pts.every(function (p) { return p[1] === 0; });
    if (quiet) card.setAttribute("data-quiet", "true");

    var head = el("div", "bucket-head");
    var id = el("div", "bucket-id");
    id.appendChild(el("h3", null, seriesTitle(s)));
    var pill = el("span", "pill " + t.cls);
    pill.appendChild(el("span", "dot " + t.cls));
    pill.appendChild(document.createTextNode(t.label));
    id.appendChild(pill);
    head.appendChild(id);

    var dl = el("dl", "readout");
    // A countdown is only meaningful when the visible range reaches the present.
    var rangeIsCurrent = b >= D.generatedAt - 5 * MIN;
    var resetText = last[4] ? fmt(Date.parse(last[4])) : "—";
    var extra = rangeIsCurrent ? untilText(last[4], D.generatedAt) : "";
    [["区间末已用", num(last[1]) + "%", "strong"],
     ["剩余", num(last[3]), null],
     ["下次重置", resetText, null]].forEach(function (r, i) {
      var box = document.createElement("div");
      box.appendChild(el("dt", null, r[0]));
      var dd = el("dd", "mono" + (r[2] ? " " + r[2] : ""), r[1]);
      if (i === 2 && extra) {
        dd.appendChild(document.createTextNode(" "));
        dd.appendChild(el("span", "soft", extra));
      }
      box.appendChild(dd);
      dl.appendChild(box);
    });
    head.appendChild(dl);
    card.appendChild(head);

    if (!quiet) {
      var drawn = capPts(pts, D.maxPoints);
      var wrap = el("div", "chart-wrap");
      wrap.innerHTML = chartSvg(drawn, s.cycles, src.outages, a, b);
      wrap.querySelector("svg").setAttribute("aria-label",
        seriesTitle(s) + " 用量随时间变化，区间末 " + num(last[1]) + "%");
      // Outage messages are collector output — set as text, never as markup.
      var rects = wrap.querySelectorAll(".outage");
      var visible = src.outages.filter(function (o) { return o[1] >= a && o[0] <= b; });
      for (var i = 0; i < rects.length && i < visible.length; i++) {
        rects[i].querySelector("title").textContent =
          "采集失败 " + fmt(visible[i][0]) + " — " + fmt(visible[i][1]) + "：" + visible[i][2];
      }
      wrap.appendChild(el("div", "tip"));
      card.appendChild(wrap);
      attachHover(wrap, drawn);
      if (drawn.length < pts.length) {
        card.appendChild(el("p", "sampled",
          "图上按峰值抽样至 " + drawn.length + " 点（区间内共 " + pts.length + " 条读数）；完整读数见下方刷新记录。"));
      }
    } else {
      card.appendChild(el("p", "quiet-note", "所选时间范围内未使用。"));
    }

    var tables = el("div", "tables");
    var cyc = s.cycles.filter(function (c) { return c[1] >= a && c[0] <= b; });
    tables.appendChild(tableBlock("配额周期", cyc.length,
      cyc.length ? "与所选区间相交的周期；周期起止是真实时刻，可能落在区间之外。" : null,
      ["周期开始", "周期结束", "峰值", "期末已用", "期末剩余", "重置时间"],
      cyc.slice().reverse().map(function (c) {
        return [{ text: fmtFull(c[0]) }, { text: fmtFull(c[1]) },
          { text: num(c[3]) + "%", cls: "mono num", dot: tier(c[3]).cls },
          { text: num(c[4]), cls: "mono num" }, { text: num(c[5]), cls: "mono num" },
          { text: c[2] ? fmt(Date.parse(c[2])) : "—" }];
      })));

    var shown = pts.slice(-D.logCap).reverse();
    tables.appendChild(tableBlock("刷新记录", pts.length,
      pts.length > D.logCap ? "显示最近 " + D.logCap + " 条，共 " + pts.length + " 条。完整记录见 ~/.config/quotacheck-mcp/history/。" : null,
      ["刷新时间", "已用", "剩余", "占比", "下次重置"],
      shown.map(function (p) {
        return [{ text: fmtFull(p[0]) }, { text: num(p[2]), cls: "mono num" },
          { text: num(p[3]), cls: "mono num" }, { text: num(p[1]) + "%", cls: "mono num" },
          { text: p[4] ? fmt(Date.parse(p[4])) : "—" }];
      })));
    card.appendChild(tables);
    return card;
  }

  /** "Gemini Models · Weekly" inside group "Gemini Models" reads as "Weekly". */
  function windowOf(s) {
    if (s.group && s.label.indexOf(s.group + " · ") === 0) {
      return s.label.slice(s.group.length + 3);
    }
    return seriesTitle(s);
  }

  /**
   * One tile per shared-limit group, falling back to one per source.
   *
   * Once a source reports groups, the overview is those groups only: legacy
   * ungrouped buckets still recorded in history stay visible as cards below,
   * but an extra catch-all tile beside the real groups would just be noise.
   */
  function tilesFor(src) {
    var order = [], byGroup = {};
    src.series.forEach(function (s) {
      var g = s.group || "";
      if (!(g in byGroup)) { byGroup[g] = []; order.push(g); }
      byGroup[g].push(s);
    });
    var grouped = order.filter(function (g) { return g !== ""; });
    if (grouped.length) order = grouped.sort();
    return order.map(function (g) { return buildTile(src, byGroup[g], g); });
  }

  function buildTile(src, series, group) {
    var a = state.from, b = state.to;
    // Headline the bucket under most pressure. On a tie — both windows at 0% —
    // prefer the one whose reset is furthest out, so a group leads with its
    // weekly rather than its 5-hour window and the tiles stay comparable.
    var best = null;
    function resetAt(p) {
      var t = p[4] ? Date.parse(p[4]) : NaN;
      return isNaN(t) ? -Infinity : t;
    }
    series.forEach(function (s) {
      var pts = inRange(s.pts, a, b);
      if (!pts.length) return;
      var last = pts[pts.length - 1];
      if (!best) { best = { s: s, last: last }; return; }
      if (last[1] > best.last[1]) { best = { s: s, last: last }; return; }
      if (last[1] === best.last[1] && resetAt(last) > resetAt(best.last)) {
        best = { s: s, last: last };
      }
    });
    var tile = el("div", "tile");
    tile.appendChild(el("p", "tile-label", group ? src.label + " · " + group : src.label));
    if (!best) {
      tile.appendChild(el("p", "tile-value soft", "无数据"));
      tile.appendChild(el("p", "tile-sub mono soft", src.errorCount + " 次失败"));
      return tile;
    }
    var t = tier(best.last[1]);
    var val = el("p", "tile-value", num(best.last[1]));
    val.appendChild(el("span", "unit", "%"));
    tile.appendChild(val);
    var sub = el("p", "tile-sub");
    sub.appendChild(el("span", "dot " + t.cls));
    sub.appendChild(document.createTextNode(t.label + " · " + windowOf(best.s)));
    tile.appendChild(sub);
    var rangeIsCurrent = b >= D.generatedAt - 5 * MIN;
    tile.appendChild(el("p", "tile-sub mono soft",
      rangeIsCurrent ? (untilText(best.last[4], D.generatedAt) || "无重置时间") : "区间末 " + fmt(best.last[0])));
    return tile;
  }

  // ---- render ------------------------------------------------------------
  var tilesBox = document.getElementById("tiles");
  var sourcesBox = document.getElementById("sources");
  var rangeLabelNode = null;

  function renderAll() {
    if (rangeLabelNode) rangeLabelNode.textContent = state.label;
    tilesBox.textContent = "";
    sourcesBox.textContent = "";
    D.sources.forEach(function (src) {
      if (state.hidden[src.id]) return;
      tilesFor(src).forEach(function (t) { tilesBox.appendChild(t); });

      var sec = el("section", "source");
      sec.setAttribute("data-source", src.id);
      var head = el("div", "source-head");
      head.appendChild(el("h2", null, src.label));
      var meta = src.eventCount + " 次采集";
      if (src.errorCount) meta += " · " + src.errorCount + " 次失败";
      head.appendChild(el("p", "meta mono", meta));
      sec.appendChild(head);

      var cards = src.series.map(function (s) { return { s: s, pts: inRange(s.pts, state.from, state.to) }; });
      // Buckets with something to show lead; idle and empty ones settle below.
      cards.sort(function (x, y) {
        var xq = !x.pts.length || x.pts.every(function (p) { return p[1] === 0; });
        var yq = !y.pts.length || y.pts.every(function (p) { return p[1] === 0; });
        return (xq ? 1 : 0) - (yq ? 1 : 0);
      });
      if (!cards.length) sec.appendChild(el("p", "empty-source", "这段时间内只有失败的采集记录。"));
      cards.forEach(function (c) { sec.appendChild(buildBucket(src, c.s)); });
      sourcesBox.appendChild(sec);
    });
  }

  // ---- controls ----------------------------------------------------------
  var filters = document.getElementById("filters");

  var range = document.createElement("details");
  range.className = "range";
  var summary = document.createElement("summary");
  var btn = el("span", "range-btn");
  btn.appendChild(el("span", "cal", "🗓"));
  rangeLabelNode = el("span", null, state.label);
  btn.appendChild(rangeLabelNode);
  btn.appendChild(el("span", "caret", "▼"));
  summary.appendChild(btn);
  range.appendChild(summary);

  var menu = el("div", "range-menu");
  var fromInput, toInput, errNode;

  function setRange(from, to, label) {
    state.from = from; state.to = to; state.label = label;
    range.open = false;
    syncPresets();
    fromInput.value = forInput(from);
    toInput.value = forInput(to);
    renderAll();
  }

  var presetButtons = [];
  function syncPresets() {
    presetButtons.forEach(function (b) {
      var on = b.dataset.label === state.label;
      b.setAttribute("aria-current", String(on));
      b.querySelector(".tick").textContent = on ? "✓" : "";
    });
  }

  function addPreset(label, compute) {
    var b = el("button", "preset");
    b.type = "button";
    b.dataset.label = label;
    b.appendChild(document.createTextNode(label));
    b.appendChild(el("span", "tick", ""));
    b.addEventListener("click", function () {
      var r = compute();
      setRange(r[0], r[1], label);
    });
    presetButtons.push(b);
    menu.appendChild(b);
  }

  addPreset("全部数据", function () { return [dataMin, dataMax]; });
  PRESETS.forEach(function (p) {
    addPreset(p.label, function () { return [D.until - p.ms, D.until]; });
  });

  var abs = el("div", "abs");
  function absRow(text, value) {
    var lab = document.createElement("label");
    lab.appendChild(el("span", null, text));
    var input = document.createElement("input");
    input.type = "datetime-local";
    input.value = value;
    lab.appendChild(input);
    abs.appendChild(lab);
    return input;
  }
  fromInput = absRow("起", forInput(state.from));
  toInput = absRow("止", forInput(state.to));
  var row = el("div", "row");
  errNode = el("span", "err", "");
  var apply = el("button", "apply", "应用");
  apply.type = "button";
  apply.addEventListener("click", function () {
    var f = Date.parse(fromInput.value), t = Date.parse(toInput.value);
    if (isNaN(f) || isNaN(t)) { errNode.textContent = "时间格式无效"; return; }
    if (f >= t) { errNode.textContent = "起始时间必须早于结束时间"; return; }
    errNode.textContent = "";
    setRange(f, t, fmt(f) + " → " + fmt(t));
  });
  row.appendChild(errNode);
  row.appendChild(apply);
  abs.appendChild(row);
  menu.appendChild(abs);
  range.appendChild(menu);
  filters.appendChild(range);

  document.addEventListener("click", function (e) {
    if (range.open && !range.contains(e.target)) range.open = false;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && range.open) range.open = false;
  });

  D.sources.forEach(function (src) {
    var chip = el("button", "chip", src.label);
    chip.type = "button";
    chip.setAttribute("aria-pressed", "true");
    chip.addEventListener("click", function () {
      var on = chip.getAttribute("aria-pressed") !== "true";
      chip.setAttribute("aria-pressed", String(on));
      state.hidden[src.id] = !on;
      renderAll();
    });
    filters.appendChild(chip);
  });

  var toggle = el("button", "ghost", "展开全部明细");
  toggle.type = "button";
  toggle.style.marginLeft = "auto";
  toggle.addEventListener("click", function () {
    var all = [].slice.call(sourcesBox.querySelectorAll("details"));
    var open = all.some(function (d) { return !d.open; });
    all.forEach(function (d) { d.open = open; });
    toggle.textContent = open ? "收起全部明细" : "展开全部明细";
  });
  filters.appendChild(toggle);

  syncPresets();
  renderAll();
})();
</script>`;
}
