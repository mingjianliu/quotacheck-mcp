# quotacheck-mcp

A robust Model Context Protocol (MCP) server and native macOS Menu Bar application that aggregates your real-time AI tool quota and usage metrics in one unified dashboard. 

Currently, `quotacheck-mcp` monitors and compiles usage across the following sources:
- **Claude Code**: Retrieves utilization rates for session/weekly quotas by extracting OAuth tokens securely from the macOS Keychain and querying Anthropic's OAuth usage endpoints.
- **Gemini Web**: Launches a headless browser using Playwright to extract live usage metrics from the Gemini web dashboard.
- **Antigravity**: Discovers the local language server port, retrieves the CSRF token, and queries its gRPC-over-JSON status endpoint.

---

## Tech Stack

- **Runtime**: Node.js >= 20
- **Language**: TypeScript (Backend/MCP Server), Swift 5.0 (macOS Menu Bar UI)
- **MCP Protocol**: `@modelcontextprotocol/sdk` (v1.x)
- **Browser Automation**: Playwright (Headless Chromium)
- **Validation**: Zod (for configuration parsing and schema safety)
- **Testing Framework**: Vitest (for unit testing and mock data assertion)
- **macOS Compilation**: Swift compiler (`swiftc`)

---

## Prerequisites

Before setting up `quotacheck-mcp`, ensure you have the following prerequisites installed on your system:
- **Node.js**: Version 20 or higher
- **macOS**: High Sierra or higher (required for native Keychain integration and compiling the SwiftUI app)
- **Google Chrome**: Recommended for sharing active sessions for browser-based scrapers (Playwright runs via system Chrome profile)

---

## Getting Started

### 1. Clone & Build the Server

```bash
git clone https://github.com/mingjianliu/quotacheck-mcp.git
cd quotacheck-mcp
npm install
npm run build
```

### 2. Connect with Claude Code

Register the MCP server inside Claude Code configuration by running:
```bash
claude mcp add quotacheck -- node /absolute/path/to/quotacheck-mcp/dist/server.js
```

Alternatively, you can manually configure your `~/.claude/config.json` to register the server:
```json
{
  "mcpServers": {
    "quotacheck": {
      "command": "node",
      "args": ["/absolute/path/to/quotacheck-mcp/dist/server.js"]
    }
  }
}
```

---

## Configuration

`quotacheck-mcp` reads from `~/.config/quotacheck-mcp/config.json`. The keys default automatically, but you can create it to override:

```json
{
  "chromeProfilePath": "/Users/yourusername/Library/Application Support/Google/Chrome",
  "chromeExecutablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "enabledSources": [
    "claude-code",
    "gemini-web",
    "antigravity"
  ],
  "playwrightTimeoutMs": 8000,
  "historyEnabled": true,
  "historyRetentionDays": 90
}
```

### Usage History

Every real collection is appended to a month-sharded log at
`~/.config/quotacheck-mcp/history/YYYY-MM.jsonl`, one `QuotaSnapshot` per line.
Cache hits are not recorded, and failures are recorded with their `error`
intact — a flat line in a report must be distinguishable from a collector that
was down. Set `historyEnabled` to `false` to turn recording off.

Shards whose entire month falls outside `historyRetentionDays` are deleted on
write. A partially-expired shard is kept whole, so up to ~30 extra days may sit
on disk; readers filter by exact cutoff, so query results are unaffected. This
keeps appends O(1) instead of rewriting a multi-megabyte file every few minutes.

At four sources polling every five minutes the log grows roughly 1,150 lines
(~500 KB) per day.

### Usage Reports

Render the recorded history as a self-contained HTML page:

```bash
npm run report                                     # last 7 days
npm run report -- --days 30
npm run report -- --days 7 --sources claude-code,gemini-web
npm run report -- --days 30 --out ~/Desktop/quota.html
```

Output defaults to `~/.config/quotacheck-mcp/reports/quota-<days>d.html`. The
page needs no network access beyond Google Fonts, and works both opened directly
from disk and published as an artifact.

Per quota bucket it shows a step chart (a reading holds until the next one — the
line never interpolates between samples), hairline markers at each observed
reset, gray bands over failed-collection windows, a per-cycle summary table
(start, end, peak, final usage, remaining, reset time) and a refresh log. A
bucket untouched for the whole window collapses to a single row instead of an
empty plot.

A quota cycle boundary is detected two ways: time crossing the reset instant the
previous sample announced, or usage collapsing. Reset times are not compared for
equality — Gemini reports a *rolling* window that drifts forward on every poll,
so equality would manufacture a cycle per refresh.

`--max-points` (default 600) caps the plotted points per series. Samples are
first collapsed by run — usage is a step function, so identical consecutive
readings carry no information — and only then, if still too dense, bucketed by
time keeping each bucket's peak.

### Authentication for Web Collectors

For the browser-based collectors (like `gemini-web`), you need to capture a browser storage session once so that Playwright can log in headlessly.

Run the interactive login command:
```bash
npm run login gemini-web
```
This opens a headed Chrome browser. Perform your Google login if requested; the browser will automatically close once the `/usage` endpoint loads, saving the authenticated state securely to `~/.config/quotacheck-mcp/gemini-web-session.json`.

---

## Architecture and Data Collectors

```
                ┌──────────────────────────────────┐
                │        quotacheck Client         │
                │    (Claude Code MCP / macOS UI)  │
                └────────────────┬─────────────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
      ┌─────────────────────┐         ┌─────────────────────┐
      │     MCP Server      │         │   macOS Menu Bar    │
      │   (dist/server.js)  │         │  (Quotacheck.app)   │
      └──────────┬──────────┘         └──────────┬──────────┘
                 │ (Run on-demand)               │ (Run script every 5m)
                 └───────────────┬───────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│   claude-code    │   │    gemini-web    │   │   antigravity    │
│  Reads Keychain  │   │ Playwright XSSI  │   │  Local language  │
│  & Queries API   │   │  JSON Scraper    │   │  server over RPC │
└──────────────────┘   └──────────────────┘   └──────────────────┘
```

### 1. Claude Code (`claude-code`)
- **Mechanism**: Reads the Anthropic OAuth credentials from the macOS Keychain under the service `"Claude Code-credentials"`.
- **API Call**: Makes an HTTPS GET request to `api.anthropic.com/api/oauth/usage` with the retrieved token to extract the 5-hour, 7-day, and sub-model (Opus, Sonnet, Omelette/Design) utilization percentages.

### 2. Gemini Web (`gemini-web`)
- **Mechanism**: Runs a headless instance of Playwright targeting `https://gemini.google.com/usage`.
- **Parser**: Listens to raw Google `batchexecute` JSON responses. It extracts the XSSI chunk frames specifically looking for RPC `jSf9Qc` (which contains consumed quota fractions and reset timestamps). If the API response isn't caught, falls back to parsing the static HTML DOM.

### 3. Antigravity (`antigravity`)
- **Mechanism**: Inspects active processes (`ps aux`) to locate the language server (`language_server` or `agy`) and extracts its `--csrf_token` argument.
- **Connection**: Detects the local port the process is listening on using `lsof` (macOS) or `ss` (Linux).
- **API Call**: Sends a POST request containing the CSRF token to `http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus` to parse model quotas.

---

## Exposed MCP Tools

The server exposes two standard tools:

- `get_all_quotas({ sources?: string[] })`: Returns a list of quota snapshots for the requested sources (or all enabled sources if omitted).
- `refresh({ sources?: string[] })`: Explicitly bypasses internal caching mechanisms to force fresh collections.

---

## Available Scripts

The following commands are available from the root of the project:

| Script | Description |
|---|---|
| `npm run build` | Compiles the TypeScript codebase (`tsc`) |
| `npm run dev` | Runs the server in stdio mode via `tsx` (great for debugging) |
| `npm run typecheck` | Validates TypeScript compiler checks without compiling output |
| `npm run test` | Runs the Vitest unit tests |
| `npm run test:watch` | Runs tests in interactive watch mode |
| `npm run smoke` | Runs a live end-to-end collector query against active configurations |
| `npm run report` | Renders recorded history as a self-contained HTML report |
| `npm run login gemini-web` | Logs in and saves authenticated session profiles for Playwright |

---

## macOS Menu Bar App

`quotacheck-mcp` ships with a native, lightweight macOS Menu Bar app built in SwiftUI.

> [!NOTE]
> The app runs inside your menu bar as an agent (`LSUIElement` in `Info.plist`), and fetches fresh data in the background every 5 minutes by calling the project's export script.

### Build and Run

```bash
cd macos
./build.sh
open Quotacheck.app
```

### Collapsible Accordion UI

Each provider in the macOS menu bar panel features a fold/unfold chevron button:
- **Expanded state**: Shows individual quota bars (Session, Weekly, Extra Usage) with custom percentage fills (coloring changes dynamically from blue to orange/red depending on utilization).
- **Collapsed state**: Minimizes the provider card, saving screen space when monitoring multiple sources.
- Animated using native SwiftUI transition styles.

---

## Troubleshooting

### Chrome Profile Locking
If Playwright errors out with a message indicating the Chrome User Data directory is locked, it means Chrome is currently running with that profile active. You can remedy this by specifying a dedicated directory or copying your profile into an isolated folder for `quotacheck-mcp` to use.

### Keychain Access Errors (Claude Code)
If you get errors reading tokens:
```
failed to read OAuth token from keychain: The specified item could not be found in the keychain.
```
Ensure you have logged in using `claude` CLI. Verify the keychain contains an item matching `"Claude Code-credentials"`.

### Antigravity Port Failure
Ensure the Antigravity companion app or language server is running. Check if `ps aux | grep language_server` displays the running daemon.
