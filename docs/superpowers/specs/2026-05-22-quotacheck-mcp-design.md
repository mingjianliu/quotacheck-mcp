# quotacheck-mcp — Design

> **Status note (2026-08-23):** the `gemini-cli` collector described below was removed from the codebase (commit `b88a5cb`) — the Cloud Code quota endpoint it depended on is permanently gone. Everything here is retained as a record of the original design, not as a description of the current system.

**Date:** 2026-05-22
**Author:** mingjianliu (with Claude Code)
**Status:** Draft — pending implementation

## Goal

A single MCP server that, on demand, reports the user's current quota state across the five AI coding tools they use:

1. **Gemini CLI** (`gemini` binary)
2. **Claude Code** (`claude` binary, `cmux.app`, `Claude.app` — all share one Anthropic account)
3. **Gemini web** (`gemini.google.com/usage`)
4. **Claude.ai design** (`claude.ai` design-feature quota — separate from Claude Code)
5. **Antigravity** (`agy` CLI + Antigravity IDE)

The MCP exposes the data so Claude Code (or any MCP client) can answer "what's my quota right now?" or "should I start this big task?" without the user manually opening five different tools.

## Non-goals

- **No manual entry.** Only sources that can be collected automatically are in scope.
- **No persistence / history.** This is a point-in-time snapshot tool. Cross-session usage tracking is out of scope; `ccusage` and `antigravity-usage` already do this and we shell out to them rather than duplicating their logic.
- **No notifications, no daemon, no TUI.** MCP server only.
- **No login flows.** All web-source authentication is inherited from the user's existing Chrome profile.

## Architecture

Single Node.js / TypeScript MCP server, stdio transport.

```
quotacheck-mcp/
├── src/
│   ├── server.ts                 # MCP boilerplate, registers tools
│   ├── collect.ts                # orchestrator: runs collectors in parallel
│   ├── types.ts                  # QuotaSnapshot shape
│   ├── config.ts                 # loads ~/.config/quotacheck-mcp/config.json
│   └── collectors/
│       ├── claude-code.ts        # ccusage-style parse of ~/.claude/projects/**
│       ├── gemini-cli.ts         # parse ~/.gemini/ state files
│       ├── antigravity.ts        # shell out to antigravity-usage --json (preferred)
│       │                         #   or parse ~/.gemini/antigravity-cli/log/
│       ├── gemini-web.ts         # Playwright → gemini.google.com/usage
│       └── claude-design.ts      # Playwright → claude.ai usage page
├── package.json
├── tsconfig.json
└── README.md
```

### Process model

- Single process, stdio MCP transport.
- No daemon, no cache. Each `get_all_quotas` call fans out to all enabled collectors **in parallel** via `Promise.allSettled`.
- Playwright launches Chromium with `chromium.launchPersistentContext(<chromeProfilePath>)` to inherit the user's live `google.com` and `claude.ai` sessions. Browser is closed at end of each call. (The user has Chrome already; this design uses the existing Chrome profile rather than installing a separate browser.)
- Web-source cold-starts are ~1.5–3s. Local-file collectors are ~50ms.

### Error isolation

A collector failure is _not_ fatal. Each `QuotaSnapshot` may carry an `error` string; other sources still return their data. The caller decides how to handle partial results.

## MCP tools

### `get_all_quotas`

```ts
input:  { sources?: SourceId[] }   // omit = all enabled sources
output: QuotaSnapshot[]
```

### `refresh`

```ts
input:  { sources?: SourceId[] }
output: QuotaSnapshot[]
```

Functionally identical to `get_all_quotas` (since there's no cache). Kept as a distinct verb so an LLM client has a clear "I want fresh data, not whatever's in memory" semantic if a cache is ever introduced later.

## Data model

```ts
type SourceId =
  | "claude-code"
  | "gemini-cli"
  | "gemini-web"
  | "claude-design"
  | "antigravity";

interface QuotaSnapshot {
  source: SourceId;
  collectedAt: string; // ISO 8601
  session?: Bucket; // e.g. Claude Code 5-hour window
  weekly?: Bucket;
  subModels?: SubModelBucket[]; // e.g. Opus weekly inside Claude Code
  error?: string; // present iff collection failed
}

interface Bucket {
  used: number;
  limit: number;
  pct: number; // 0-100
  resetsAt?: string; // ISO 8601, when the bucket refreshes
}

interface SubModelBucket extends Bucket {
  name: string; // "opus", "gemini-2.5-pro", etc.
}
```

A collector populates only the fields it can authoritatively fill. Unsupported buckets are left `undefined` rather than zeroed.

## Per-source collection

| Source            | Method                                                                                                                                                                                        | Notes                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **claude-code**   | Parse `~/.claude/projects/**/*.jsonl` for token counts; cross-reference plan limits from a hardcoded `plans.json` table. Mirrors `ccusage` logic.                                             | Fully local, no network. ~50ms. Plan-limit table needs seasonal refresh — same maintenance cadence as the project's other seasonal data. |
| **gemini-cli**    | Read `~/.gemini/state.json` and history files. Spike during implementation to confirm exact field locations. Fallback: scripted `gemini -p "/stats"` capture if local files are insufficient. | One open question — the local state-file format isn't documented. Resolved during implementation, not blocking this spec.                |
| **antigravity**   | Prefer shelling out to `antigravity-usage --json` (third-party, well-maintained). Fall back to parsing `~/.gemini/antigravity-cli/log/cli-*.log`.                                             | Treats `antigravity-usage` as a soft dependency — declared in README, not bundled.                                                       |
| **gemini-web**    | Playwright (persistent context using user's Chrome profile) → `https://gemini.google.com/usage`. DOM-parse per-model quota rows.                                                              | Brittle to UI changes. On parse failure, collector returns `{ error: "..." }`.                                                           |
| **claude-design** | Playwright (same persistent context) → claude.ai usage page (exact path resolved during implementation). DOM-parse design-quota row.                                                          | Same brittleness caveat as `gemini-web`.                                                                                                 |

Plan-limit table (`plans.json`) is checked into the repo and updated manually when Anthropic / Google publish new tier limits.

## Configuration

`~/.config/quotacheck-mcp/config.json` — created on first run with defaults, hand-edit to override:

```json
{
  "chromeProfilePath": "/Users/<you>/Library/Application Support/Google/Chrome/Default",
  "enabledSources": [
    "claude-code",
    "gemini-cli",
    "gemini-web",
    "claude-design",
    "antigravity"
  ],
  "playwrightTimeoutMs": 8000,
  "antigravityUsageBinary": "antigravity-usage"
}
```

- `chromeProfilePath` is auto-detected on macOS; configurable for other OSes or non-default profiles.
- `enabledSources` lets the user disable a flaky source without code changes.
- `playwrightTimeoutMs` gates how long a web collector waits before erroring out.

## Installation & MCP registration

```bash
npm install -g quotacheck-mcp
npx playwright install chromium    # only required if not reusing system Chrome

# Register with Claude Code:
claude mcp add quotacheck -- quotacheck-mcp
```

(The Playwright Chromium install can be skipped because we reuse the user's Chrome via `executablePath` + `launchPersistentContext`.)

## Testing strategy

- **Unit tests** for each collector's _parser_ layer (given a recorded fixture file, does it produce the expected `QuotaSnapshot`?).
- **No live tests against gemini.google.com or claude.ai** in CI — those rely on the user's logged-in browser. A manual `npm run smoke` script exercises real collection on the developer's machine.
- **Type checks** via `tsc --noEmit` in CI.
- **MCP-protocol integration test** using the official MCP SDK's test harness — verify both tools register and return shaped data given mocked collectors.

## Open items resolved during implementation

1. **Gemini CLI quota field location** — short investigation spike before writing `gemini-cli.ts`.
2. **Exact claude.ai design-quota page path** — confirmed by opening claude.ai while logged in.
3. **Chrome profile detection on non-mac OSes** — only relevant if user ever uses this on Linux; deferred until needed.

## Future extensions (out of scope for v1)

- Optional caching layer (TTL config, `refresh` becomes meaningful).
- Background polling with notifications when a bucket crosses a threshold.
- A thin CLI (`quotacheck`) over the same collector library for terminal use without MCP.
- Manual-entry fallback for sources that lose their auto-collection (e.g., if Google removes the usage page).
