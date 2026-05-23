# claude-design Collector Rewrite — XHR Interception

**Date:** 2026-05-23  
**Status:** Approved

## Problem

The current `collectClaudeDesign` navigates to `claude.ai/settings/usage` with Playwright and regex-parses the rendered HTML. It is broken in production ("design quota row not found on page") because the real page structure doesn't match the regex. HTML parsing is inherently fragile to layout changes.

## Approach

Replace HTML parsing with in-session XHR interception. The page makes client-side API calls to `claude.ai/api/*` to load quota data. By registering a Playwright `page.on('response')` listener before navigation, we capture those JSON responses directly — no HTML parsing at all.

## Architecture

### Data Flow

1. Launch browser via existing `launchWithLockWorkaround` (no change to session management).
2. Register `page.on('response', handler)` before `page.goto`.
3. Handler appends every `claude.ai/api/*` JSON response to a `CapturedResponse[]` array: `{ url: string, body: unknown }`.
4. Navigate to `https://claude.ai/settings/usage` with `waitUntil: "networkidle"`.
5. Call `parseDesignApiResponse(captured)` on the collected responses.
6. Return the resulting `QuotaSnapshot`.

### New Pure Parser

```ts
interface CapturedResponse {
  url: string;
  body: unknown;
}
function parseDesignApiResponse(
  responses: CapturedResponse[],
  now: Date,
): QuotaSnapshot;
```

- Scans responses for one containing design quota fields (e.g. `design`, `used`, `limit`, `resets_at` — exact names confirmed on first live run).
- Returns a populated `QuotaSnapshot` on success.
- If no match: returns error with list of intercepted URLs for debugging.
- If match but wrong shape: returns error with truncated raw body.

### Endpoint Discovery

On first live run the collector logs (to stderr) every intercepted `claude.ai/api/*` URL. This surfaces the real endpoint name without a separate investigation script. The JSON fixture is then updated to match the real response shape.

## Testing

| File                                             | Change                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `tests/collectors/claude-design.parser.test.ts`  | Rewritten to test `parseDesignApiResponse` against a JSON fixture                                           |
| `tests/fixtures/claude-design-api-response.json` | New — placeholder shape until first live run confirms real shape                                            |
| `tests/fixtures/claude-design-usage.html`        | Kept until JSON approach confirmed end-to-end, then deleted                                                 |
| `src/collectors/claude-design.ts`                | `parseClaudeDesign` replaced by `parseDesignApiResponse`; `collectClaudeDesign` gains response interception |

## Error Handling

| Scenario                           | Error message                                                             |
| ---------------------------------- | ------------------------------------------------------------------------- |
| No matching JSON response captured | `"no design quota API response captured; intercepted: [url1, url2, ...]"` |
| Match found but fields missing     | `"design API response missing expected fields; body: <truncated>"`        |
| Playwright/navigation failure      | Existing try/catch propagates message (no change)                         |

## Out of Scope

- Changing the `Collector` interface or `CollectorContext` types.
- Modifying other collectors.
- Falling back to HTML parsing (removed entirely).
