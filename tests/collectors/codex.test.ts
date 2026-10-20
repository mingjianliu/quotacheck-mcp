import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRateLimits,
  collectCodex,
  type AccountRateLimits,
} from "../../src/collectors/codex.js";

// Verbatim `account/rateLimits/read` response from `codex app-server`,
// accountId scrubbed. Plus plan: a 5-hour primary and a weekly secondary.
const SAMPLE: AccountRateLimits = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests", "fixtures", "codex-rate-limits.json"),
    "utf8",
  ),
);

describe("parseRateLimits", () => {
  it("maps the primary window onto session and the secondary onto weekly", () => {
    const { session, weekly } = parseRateLimits(SAMPLE);
    expect(session).toMatchObject({ used: 31, limit: 100, pct: 31 });
    expect(weekly).toMatchObject({ used: 5, limit: 100, pct: 5 });
  });

  it("converts the epoch-second reset into an ISO timestamp", () => {
    // Every other collector hands the report an ISO string; codex reports
    // seconds since the epoch.
    const { session, weekly } = parseRateLimits(SAMPLE);
    expect(session?.resetsAt).toBe("2026-09-07T01:49:54.000Z");
    expect(weekly?.resetsAt).toBe("2026-09-13T20:49:54.000Z");
  });

  it("omits a window the backend did not report", () => {
    const noSecondary: AccountRateLimits = {
      rateLimits: { ...SAMPLE.rateLimits, secondary: null },
    };
    const { session, weekly } = parseRateLimits(noSecondary);
    expect(session).toBeDefined();
    expect(weekly).toBeUndefined();
  });

  it("omits a reset time rather than inventing one when it is absent", () => {
    const noReset: AccountRateLimits = {
      rateLimits: {
        ...SAMPLE.rateLimits,
        primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: null },
      },
    };
    expect(parseRateLimits(noReset).session?.resetsAt).toBeUndefined();
  });

  it("emits no subModels when the account meters a single limit", () => {
    // session + weekly already say everything; a per-limit breakdown of one
    // limit would just repeat them.
    expect(parseRateLimits(SAMPLE).subModels).toBeUndefined();
  });

  it("emits one grouped bucket per window when several limits are metered", () => {
    const twoLimits: AccountRateLimits = {
      rateLimits: SAMPLE.rateLimits,
      rateLimitsByLimitId: {
        codex: SAMPLE.rateLimits,
        "codex-mini": {
          limitId: "codex-mini",
          limitName: "Codex Mini",
          primary: {
            usedPercent: 12,
            windowDurationMins: 300,
            resetsAt: 1788745794,
          },
          secondary: {
            usedPercent: 60,
            windowDurationMins: 10080,
            resetsAt: 1789332594,
          },
        },
      },
    };
    const subModels = parseRateLimits(twoLimits).subModels!;
    // Group ascending, weekly before 5-hour inside a group — the same order
    // antigravity uses, so history rows never reshuffle.
    expect(subModels.map((b) => b.name)).toEqual([
      "codex · Weekly",
      "codex · 5-hour",
      "Codex Mini · Weekly",
      "Codex Mini · 5-hour",
    ]);
    expect(subModels.map((b) => b.group)).toEqual([
      "codex",
      "codex",
      "Codex Mini",
      "Codex Mini",
    ]);
    expect(subModels[2]).toMatchObject({ used: 60, limit: 100, pct: 60 });
  });

  it("labels an unfamiliar window by its duration", () => {
    const daily: AccountRateLimits = {
      rateLimits: SAMPLE.rateLimits,
      rateLimitsByLimitId: {
        codex: SAMPLE.rateLimits,
        other: {
          limitId: "other",
          primary: { usedPercent: 1, windowDurationMins: 1440, resetsAt: null },
          secondary: null,
        },
      },
    };
    const names = parseRateLimits(daily).subModels!.map((b) => b.name);
    expect(names).toContain("other · Daily");
  });
});

describe("collectCodex", () => {
  it("returns a codex snapshot built from the app-server response", async () => {
    const snap = await collectCodex(undefined, {
      now: new Date("2026-09-06T21:00:00.000Z"),
      read: async () => SAMPLE,
    });
    expect(snap.source).toBe("codex");
    expect(snap.collectedAt).toBe("2026-09-06T21:00:00.000Z");
    expect(snap.error).toBeUndefined();
    expect(snap.session?.pct).toBe(31);
    expect(snap.weekly?.pct).toBe(5);
  });

  it("reports the failure instead of throwing when the app-server call fails", async () => {
    const snap = await collectCodex(undefined, {
      now: new Date("2026-09-06T21:00:00.000Z"),
      read: async () => {
        throw new Error("codex: command not found");
      },
    });
    expect(snap.source).toBe("codex");
    expect(snap.error).toContain("command not found");
    expect(snap.session).toBeUndefined();
  });

  it("fails loudly when the response carries no window at all", async () => {
    // A signed-out CLI answers with an empty snapshot. Reporting that as a
    // successful read would show codex sitting at 0% forever.
    const snap = await collectCodex(undefined, {
      now: new Date("2026-09-06T21:00:00.000Z"),
      read: async () => ({ rateLimits: { primary: null, secondary: null } }),
    });
    expect(snap.error).toBeTruthy();
    expect(snap.session).toBeUndefined();
  });

  it("passes the configured binary through to the reader", async () => {
    let seen = "";
    await collectCodex(
      { codexBinary: "/opt/bin/codex" },
      {
        read: async (binary) => {
          seen = binary;
          return SAMPLE;
        },
      },
    );
    expect(seen).toBe("/opt/bin/codex");
  });
});

describe("account identity", () => {
  const read = (email: string) => async () => ({ limits: SAMPLE, account: { type: "chatgpt", email, planType: "plus" } });

  it("keys readings by a hash of the signed-in email and never stores the email", async () => {
    const a = await collectCodex(undefined, { now: new Date(0), read: read("Someone@Example.com") });
    const b = await collectCodex(undefined, { now: new Date(0), read: read("someone@example.com") });
    const c = await collectCodex(undefined, { now: new Date(0), read: read("other@example.com") });
    expect(a.accountKey).toMatch(/^chatgpt:[0-9a-f]{24}(:[0-9a-f]{24})?$/);
    expect(a.accountKey).toBe(b.accountKey);
    expect(c.accountKey).not.toBe(a.accountKey);
    expect(a.extensions?.account).toEqual({ type: "chatgpt", planType: "plus", label: "S…@Example.com · plus" });
    expect(JSON.stringify(a)).not.toContain("Someone@");
  });

  it("still reports quota when the CLI cannot say who is signed in", async () => {
    const snap = await collectCodex(undefined, { now: new Date(0), read: async () => SAMPLE });
    expect(snap.error).toBeUndefined();
    expect(snap.accountKey).toBeUndefined();
  });
});

describe("workspace identity", () => {
  it("separates one email's personal plan from its Team workspace", async () => {
    const read = (accountId: string | undefined, planType: string) => async () => ({
      limits: { ...SAMPLE, accountId, rateLimits: { ...SAMPLE.rateLimits, planType } },
      account: { type: "chatgpt", email: "someone@example.com", planType: "plus" },
    });
    const personal = await collectCodex(undefined, { now: new Date(0), read: read("ws-personal", "plus") });
    const team = await collectCodex(undefined, { now: new Date(0), read: read("ws-team", "team") });
    expect(personal.accountKey).toMatch(/^chatgpt:[0-9a-f]{24}:[0-9a-f]{24}$/);
    expect(team.accountKey).not.toBe(personal.accountKey);
    expect((team.extensions?.account as { label?: string }).label).toBe("s…@example.com · team");
    expect(JSON.stringify(team.accountKey)).not.toContain("ws-team");
  });
});
