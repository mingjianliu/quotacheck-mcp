# claude-design Collector XHR Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken HTML-regex parser in `collectClaudeDesign` with Playwright XHR response interception that captures the design quota JSON directly from `claude.ai/api/*` calls.

**Architecture:** Register `page.on('response')` before `page.goto` to collect all `claude.ai/api/*` JSON responses; pass them to a pure `parseDesignApiResponse` function that scans for a body containing a `design` key with `used`/`limit` fields. No HTML parsing at all.

**Tech Stack:** TypeScript, Playwright, Vitest

---

## File Map

| File                                             | Action  | Responsibility                                                                         |
| ------------------------------------------------ | ------- | -------------------------------------------------------------------------------------- |
| `tests/fixtures/claude-design-api-response.json` | Create  | Placeholder JSON fixture (updated after first live run)                                |
| `tests/collectors/claude-design.parser.test.ts`  | Rewrite | Tests `parseDesignApiResponse` against JSON fixture                                    |
| `src/collectors/claude-design.ts`                | Rewrite | New `CapturedResponse` type + `parseDesignApiResponse` + updated `collectClaudeDesign` |
| `tests/fixtures/claude-design-usage.html`        | Keep    | Deleted only after JSON approach is confirmed end-to-end                               |

---

## Task 1: Create JSON fixture and write failing parser tests

**Files:**

- Create: `tests/fixtures/claude-design-api-response.json`
- Rewrite: `tests/collectors/claude-design.parser.test.ts`

- [ ] **Step 1: Create the placeholder JSON fixture**

Create `tests/fixtures/claude-design-api-response.json`:

```json
{
  "design": {
    "used": 12,
    "limit": 100,
    "resets_at": "2026-05-22T05:00:00Z"
  }
}
```

- [ ] **Step 2: Rewrite the parser test file**

Overwrite `tests/collectors/claude-design.parser.test.ts` entirely:

```typescript
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
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
npx vitest run tests/collectors/claude-design.parser.test.ts
```

Expected: FAIL — `parseDesignApiResponse is not exported` (or similar import error). If it somehow passes, something is wrong — stop and investigate.

- [ ] **Step 4: Commit fixture and test**

```bash
git add tests/fixtures/claude-design-api-response.json tests/collectors/claude-design.parser.test.ts
git commit -m "test: failing tests for parseDesignApiResponse XHR parser"
```

---

## Task 2: Implement `parseDesignApiResponse` in the collector

**Files:**

- Modify: `src/collectors/claude-design.ts`

- [ ] **Step 1: Replace the contents of `src/collectors/claude-design.ts`**

The key changes: add `CapturedResponse` interface, replace `parseClaudeDesign` with `parseDesignApiResponse`, keep `collectClaudeDesign` signature identical but stub the new parser path temporarily (full XHR wiring comes in Task 3).

```typescript
import { launchWithLockWorkaround } from "../utils/playwright.js";
import type { Collector, CollectorContext, QuotaSnapshot } from "../types.js";

const USAGE_URL = "https://claude.ai/settings/usage";

export interface CapturedResponse {
  url: string;
  body: unknown;
}

export function parseDesignApiResponse(
  responses: CapturedResponse[],
  now: Date,
): QuotaSnapshot {
  const interceptedUrls = responses.map((r) => r.url);

  for (const { body } of responses) {
    if (!body || typeof body !== "object") continue;
    const b = body as Record<string, unknown>;

    if (b.design && typeof b.design === "object") {
      const d = b.design as Record<string, unknown>;
      if (typeof d.used === "number" && typeof d.limit === "number") {
        return {
          source: "claude-design",
          collectedAt: now.toISOString(),
          session: {
            used: d.used,
            limit: d.limit,
            pct: d.limit > 0 ? (d.used / d.limit) * 100 : 0,
            resetsAt: typeof d.resets_at === "string" ? d.resets_at : undefined,
          },
        };
      }
      return {
        source: "claude-design",
        collectedAt: now.toISOString(),
        error: `design API response missing expected fields; body: ${JSON.stringify(body).slice(0, 300)}`,
      };
    }
  }

  return {
    source: "claude-design",
    collectedAt: now.toISOString(),
    error: `no design quota API response captured; intercepted: ${JSON.stringify(interceptedUrls)}`,
  };
}

export async function collectClaudeDesign(opts: {
  chromeProfilePath: string;
  chromeExecutablePath?: string;
  timeoutMs: number;
  now?: Date;
}): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  let cleanup: (() => Promise<void> | void) | null = null;
  try {
    const result = await launchWithLockWorkaround(opts.chromeProfilePath, {
      executablePath: opts.chromeExecutablePath,
      timeout: opts.timeoutMs,
    });
    const ctx = result.context;
    cleanup = result.cleanup;

    const captured: CapturedResponse[] = [];
    const page = await ctx.newPage();

    page.on("response", async (res) => {
      const url = res.url();
      const ct = res.headers()["content-type"] ?? "";
      if (url.includes("claude.ai/api/") && ct.includes("application/json")) {
        try {
          const body = await res.json();
          captured.push({ url, body });
          console.error(`[claude-design] captured: ${url}`);
        } catch {
          // ignore parse failures
        }
      }
    });

    await page.goto(USAGE_URL, {
      timeout: opts.timeoutMs,
      waitUntil: "networkidle",
    });

    return parseDesignApiResponse(captured, now);
  } catch (e) {
    return {
      source: "claude-design",
      collectedAt: now.toISOString(),
      error: (e as Error).message,
    };
  } finally {
    if (cleanup) await cleanup();
  }
}

export const claudeDesignCollector: Collector = {
  source: "claude-design",
  collect: (ctx: CollectorContext) =>
    collectClaudeDesign({
      chromeProfilePath: ctx.chromeProfilePath,
      chromeExecutablePath: ctx.chromeExecutablePath,
      timeoutMs: ctx.playwrightTimeoutMs,
    }),
};
```

- [ ] **Step 2: Run the parser tests to confirm they pass**

```bash
npx vitest run tests/collectors/claude-design.parser.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 3: Run the full test suite to check for regressions**

```bash
npm test
```

Expected: all tests pass. The `collectClaudeDesign` integration path is not unit-tested (it needs a browser), so no new failures are expected.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/collectors/claude-design.ts
git commit -m "feat: replace HTML parser with XHR interception in claude-design collector"
```

---

## Task 3: Update fixture after first live run (deferred)

**Context:** The JSON fixture in `tests/fixtures/claude-design-api-response.json` is a placeholder. The real `design` API response shape from `claude.ai` is unknown until the collector runs successfully in an authenticated session.

**Files:**

- Modify: `tests/fixtures/claude-design-api-response.json`
- Modify: `tests/collectors/claude-design.parser.test.ts` (if field names differ)
- Modify: `src/collectors/claude-design.ts` (if shape requires parser adjustment)
- Delete: `tests/fixtures/claude-design-usage.html` (once JSON path confirmed)

- [ ] **Step 1: Run the MCP server and trigger a collection**

```bash
npm run build && node dist/server.js
```

Then call `get_all_quotas` via MCP. The collector logs to stderr — look for lines starting with `[claude-design] captured:` to find the real API URL.

- [ ] **Step 2: Record the real JSON response**

Capture the response body from the logged URL (e.g. via browser DevTools Network tab with the real session, now that we know which endpoint to look at). Save it to `tests/fixtures/claude-design-api-response.json`.

- [ ] **Step 3: Update parser and tests if shape differs from placeholder**

If the real shape differs from `{ design: { used, limit, resets_at } }`:

- Update `parseDesignApiResponse` in `src/collectors/claude-design.ts` to match actual fields
- Update the test assertions in `tests/collectors/claude-design.parser.test.ts` to match
- Re-run `npx vitest run tests/collectors/claude-design.parser.test.ts` — all 4 tests must pass

- [ ] **Step 4: Delete the old HTML fixture and confirm tests pass**

```bash
rm tests/fixtures/claude-design-usage.html
npm test
```

Expected: all tests pass (no test references the HTML fixture anymore).

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/claude-design-api-response.json tests/collectors/claude-design.parser.test.ts src/collectors/claude-design.ts
git rm tests/fixtures/claude-design-usage.html
git commit -m "feat: update claude-design fixture and parser to real API shape"
```
