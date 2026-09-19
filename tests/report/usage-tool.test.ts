import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory } from "../../src/history.js";
import { getUsageHistory, USAGE_WINDOW_DAYS } from "../../src/report/usage-tool.js";
import type { QuotaSnapshot, SourceId } from "../../src/types.js";

const NOW = new Date("2026-08-10T00:00:00.000Z");
const DAY = 24 * 3_600_000;

function snap(source: SourceId, daysAgo: number, pct: number): QuotaSnapshot {
  return {
    source,
    collectedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    weekly: {
      used: pct,
      limit: 100,
      pct,
      resetsAt: new Date(NOW.getTime() + DAY).toISOString(),
    },
  };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "quotacheck-usage-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("getUsageHistory", () => {
  it("covers the seven days before now", () => {
    appendHistory(
      home,
      [snap("codex", 9, 1), snap("codex", 8, 5), snap("codex", 6, 20), snap("codex", 1, 50)],
      { now: NOW },
    );
    const { history } = getUsageHistory(home, { now: NOW, utcOffsetMin: 0 });
    expect(USAGE_WINDOW_DAYS).toBe(7);
    expect(history.since).toBe(NOW.getTime() - 7 * DAY);
    expect(history.until).toBe(NOW.getTime());
    // the readings from 9 and 8 days ago are outside the window
    expect(history.quotas[0].consumedPct).toBe(30);
  });

  it("limits the result to the requested sources", () => {
    appendHistory(home, [snap("codex", 2, 5), snap("claude-code", 2, 5)], {
      now: NOW,
    });
    const { history } = getUsageHistory(home, {
      now: NOW,
      utcOffsetMin: 0,
      sources: ["codex"],
    });
    expect(history.quotas.map((q) => q.source)).toEqual(["codex"]);
  });

  it("returns the chart as text alongside the data", () => {
    appendHistory(home, [snap("codex", 2, 5)], { now: NOW });
    const { text } = getUsageHistory(home, { now: NOW, utcOffsetMin: 0 });
    expect(text).toContain("━━━━ codex ━━━━");
  });
});
