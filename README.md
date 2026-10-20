# quotacheck-mcp

A robust Model Context Protocol (MCP) server and native macOS Menu Bar application that aggregates your real-time AI tool quota and usage metrics in one unified dashboard. 

Currently, `quotacheck-mcp` monitors and compiles usage across the following sources:
- **Claude Code**: Asks the installed Claude Code engine for its plan usage (session, weekly and model-scoped limits) with a `get_usage` control request; no prompt is sent and no credentials are read.
- **Gemini Web**: Launches a headless browser using Playwright to extract live usage metrics from the Gemini web dashboard.
- **Antigravity**: Runs the `agy` CLI in print mode and reads its JSON quota summary (or, on older builds, its quota table) for both metered model groups.
- **Codex**: Speaks JSON-RPC to `codex app-server` and reads the account rate-limit snapshot the Codex TUI shows under `/status`.

---

## Tech Stack

- **Runtime**: Node.js >= 20
- **Language**: TypeScript (Backend/MCP Server), Swift 5.7+ (macOS Menu Bar UI)
- **MCP Protocol**: `@modelcontextprotocol/sdk` (v1.x)
- **Browser Automation**: Playwright (Headless Chromium)
- **Validation**: Zod (for configuration parsing and schema safety)
- **Testing Framework**: Vitest (for unit testing and mock data assertion)
- **macOS Compilation**: Swift compiler (`swiftc`)

---

## Prerequisites

Before setting up `quotacheck-mcp`, ensure you have the following prerequisites installed on your system:
- **Node.js**: Version 20 or higher
- **macOS**: required for the Claude Keychain integration; the menu bar app needs macOS 13 (Ventura) or later
- **Google Chrome**: Recommended for the one-time Gemini login (`quotacheck login gemini-web`); collection then runs headless from the saved session

---

## Getting Started

### 1. Clone & Build the Server

```bash
git clone https://github.com/mingjianliu/quotacheck-mcp.git
cd quotacheck-mcp
npm install
npm run build
```

### 2. Start background collection

Install the CLI after building, then start the collector independently of MCP clients:

```bash
npm install -g .
quotacheck daemon
```

On macOS, `quotacheck install-service` installs and starts the user launchd service
`com.quotacheck.poller` instead. Run it again after moving the installation or changing
Node's path. Other platforms can supervise `quotacheck daemon` themselves. The service's
PATH covers `~/.local/bin`, the directory of the Node it runs under (where `npm i -g`
puts `claude` and `codex` under nvm or volta), `/opt/homebrew/bin` and `/usr/local/bin`.

All clients read stored observations. `refresh` submits a request to the service;
it never starts its own collector and respects each source's cooldown. The one
exception: a source whose last attempt failed authentication may be retried by a
manual refresh after one minute, so signing in again (or switching accounts) takes
effect without waiting. Without a manual refresh such a source is retried hourly.
Closing the menu bar or all MCP clients does not stop the service. An offline
service is reported explicitly.

### 3. Connect with Claude Code

Register the MCP server inside Claude Code configuration by running:
```bash
claude mcp add quotacheck -- node /absolute/path/to/quotacheck-mcp/dist/server.js
```

Alternatively, add it to a project's `.mcp.json`:
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
    "antigravity",
    "codex"
  ],
  "playwrightTimeoutMs": 8000,
  "antigravityUsageBinary": "agy",
  "codexBinary": "codex",
  "historyEnabled": true,
  "historyRetentionDays": 90,
  "rawEnabled": true,
  "rawRetentionDays": 30,
  "collectionIntervalMs": 300000,
  "collectionIntervals": {},
  "staleAfterMs": 900000,
  "collectorTimeoutMs": 90000
}
```

### Usage History

New observations are appended to private daily logs at
`~/.config/quotacheck-mcp/observations/YYYY-MM-DD.jsonl`. Closed days are compressed.
Old `history/YYYY-MM.jsonl` files remain readable and are not rewritten. Successful
unchanged observations are recorded; cache reads do not create observations. Failed
attempts retain their structured error rather than turning into flat usage lines.

Redacted source usage payloads are stored separately under `raw/` by default. Set
`rawEnabled: false` to disable these copies; `historyEnabled: false` disables new
history entirely. Normalized observations still preserve unknown usage fields in
`extensions`. Credentials, cookies, authentication requests, and unrelated browser
responses are not captured. Common secret/PII keys and bearer strings are redacted;
unknown provider fields can still contain personal information. Data directories
are user-private on POSIX systems; platform ACLs govern Windows access. Retention
is 90 days for observations and 30 days for raw payloads by default.

Collection is best effort: sleep, network failures and provider cooldown cause gaps.
Readouts expose observation age, errors and gaps instead of inventing samples. A
failed critical state write stops further collection. An interrupted request leaves
a conservative one-hour deadline for Claude across restart; other sources wait for
the longer of their sampling interval and request timeout. After repairing a storage fault,
restart the service; do not delete scheduling state to bypass rate limits.

The API distinguishes source-reported values from derived and legacy values.
Percentage-only limits do not claim absolute consumption counts. Known aliases share
stable semantic IDs; unrecognized source paths and scopes without stable identifiers
are marked with weak identity. Account identity is `unknown` unless a source supplies
it (Codex does, from `account/read`); do not assume historical data spanning a login change belongs to one account.

### Structured queries

```bash
quotacheck quotas --sources claude-code
quotacheck status
quotacheck refresh --sources claude-code
quotacheck history --from 2026-09-27T00:00:00Z --to 2026-09-28T00:00:00Z --granularity raw
quotacheck history --from 2026-09-27T00:00:00Z --to 2026-09-28T00:00:00Z --page-size 20 --include-raw
```

MCP equivalents are `get_quotas`, `get_status`, `refresh`, and `get_history`.
Filters support sources, accountKeys and limitIds. History intervals are `[from,to)`;
raw pages default to 100 records (maximum 1000), or 20 with includeRaw. Supply the
returned cursor with exactly the same query to continue. New observations are
excluded from an existing pagination session; modification of old legacy logs
invalidates its cursor. Aggregation supports 5m/30m/1h/1d, reports first/last/min/max
and sample counts, and separates accounts, units and reset cycles. Unknown cycles
remain separate samples. Coverage is the fraction of expected sampling slots with
a successful observation; gap boundaries bound missing evidence, not proven downtime.
Raw objects above 256 KiB return an export hint: `quotacheck export OBSERVATION_ID`.

`QUOTACHECK_HOME` or CLI `--home` selects an alternate **home root**, useful for
isolated deployments and testing; data lives under its `.config/quotacheck-mcp`.
The tool provides evidence, not task attribution, token regression or forecasts.


At four sources polling every five minutes the log grows roughly 1,150 lines
(~500 KB) per day.

### Usage Reports

Render the recorded history as a self-contained HTML page:

```bash
quotacheck report                                  # last 30 days
quotacheck report --days 7 --sources codex --out ~/Desktop/quota.html
npm run report                                     # same, from a checkout
npm run report -- --days 30
npm run report -- --days 7 --sources claude-code,gemini-web
npm run report -- --days 30 --out ~/Desktop/quota.html
```

Output defaults to `~/.config/quotacheck-mcp/reports/quota-<days>d.html` and is
readable only by you (mode 0600). The
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
quotacheck login gemini-web          # or, from a checkout: npm run login gemini-web
```
This opens a headed Chrome browser. Perform your Google login if requested; the browser will automatically close once the `/usage` endpoint loads, saving the authenticated state to `~/.config/quotacheck-mcp/gemini-web-session.json` (mode 0600, since it holds Google cookies). Pass `--home` (or set `QUOTACHECK_HOME`) to match a service running under another home root.

---

## Architecture and Data Collectors

```text
MCP / CLI / menu bar / reports
       | read observations and status
       v
Shared query layer <----- private state + daily history
       | refresh request                 ^
       v                                 | single writer
Local IPC ----------> background coordinator
                           |
                source adapters (Claude / Gemini / Antigravity / Codex)
```

### 1. Claude Code (`claude-code`)
- **Mechanism**: Starts a headless `claude -p --input-format stream-json --output-format stream-json` with hooks disabled, in a private working directory, and sends one `get_usage` control request. The engine answers with the same `rate_limits` object as Anthropic's OAuth usage endpoint, fetched with its own login, and is stopped. No prompt is sent, so nothing is billed, and no token passes through this tool. Works wherever Claude Code runs, Linux included.
- **Engine**: the CLI's install places (`~/.local/bin`, `~/.claude/local`, Homebrew, `/usr/local/bin`), the native installer's newest `~/.local/share/claude/versions`, `PATH`, the service's Node directory, then the desktop app's Code-tab engine.
- **Account**: keyed by a hash of the `accountUuid` / `organizationUuid` pair in `~/.claude.json` (`$CLAUDE_CONFIG_DIR` if set), read before and after the query; a reading taken while the login changed is discarded. A login without plan limits is told apart from a signed-out engine with `claude auth status --json`.
- **Fallback**: on macOS with no engine found, the OAuth token in the Keychain item `"Claude Code-credentials"` and `api.anthropic.com/api/oauth/usage`, as before.

### 2. Gemini Web (`gemini-web`)
- **Mechanism**: Runs a headless instance of Playwright targeting `https://gemini.google.com/usage`.
- **Parser**: Listens to raw Google `batchexecute` JSON responses. It extracts the XSSI chunk frames specifically looking for RPC `jSf9Qc` (which contains consumed quota fractions and reset timestamps). If the API response isn't caught, falls back to parsing the static HTML DOM.

### 3. Antigravity (`antigravity`)
- **Mechanism**: Runs `agy -p /usage --output-format json` (agy 1.1.11+; the binary is configurable via `antigravityUsageBinary`) and reads each group's buckets: id, window, remaining fraction and reset time. Older builds fall back to `agy -p "/quota"` and its tab-separated rows. Slash commands expand in print mode, so this consumes no model tokens. Limit ids are the same from either output, so history continues across an agy upgrade.
- **Shape**: Antigravity meters two *groups* — Gemini models, and Claude/GPT models — each with a weekly limit and a 5-hour limit, giving four buckets. Limits are per group, not per model.
- **Why not the language server**: its `GetUserStatus` RPC reflects the 5-hour window alone. `RetrieveUserQuotaSummary` does carry the weekly limit, but agy's own server answers only requests with a CSRF token that no command line shows, and the IDE's server needs Antigravity.app running. The CLI needs neither.

### 4. Codex (`codex`)
- **Mechanism**: Spawns `codex app-server` (the binary is configurable via `codexBinary`), performs the `initialize` handshake over stdio JSON-RPC, then calls `account/rateLimits/read`. The child is killed as soon as the reply arrives.
- **Shape**: The backend reports `primary` (a 5-hour window) and `secondary` (weekly), each already a percentage of its own limit, with resets as epoch seconds. These map onto `session` and `weekly`. `rateLimitsByLimitId` becomes grouped sub-model buckets only when an account meters more than one limit; with the usual single `codex` limit it would merely duplicate the two top-level buckets.
- **Why the app-server**: it is the same snapshot the TUI shows under `/status`, it answers in well under a second, and it consumes no model tokens — unlike driving the CLI in print mode. Codex keeps its own credentials, so `~/.codex/auth.json` is never read.

---

## Running alongside Agent HUD

[Agent HUD](https://github.com/jazzenchen/agent-hud-open) shows quotas, tokens and approvals at the notch and on iPhone and Apple Watch; quotacheck keeps the long history, the reports and the MCP tools an agent can query. The Claude, Antigravity and Codex readers here follow Agent HUD's approach (Apache-2.0).

Agent HUD's iPhone app reads what the Agent HUD Mac app collects, so both run on the Mac. Each then asks Claude's usage service on its own, and Agent HUD already asks every few minutes while an agent works, so slow quotacheck's Claude collection down to keep the combined rate low:

```json
{ "collectionIntervals": { "claude-code": 1800000 } }
```

## Exposed MCP Tools

The server exposes six tools:

- `get_quotas({ sources?, accountKeys?, limitIds? })`: Complete observations with freshness, scopes, units, provenance and errors.
- `get_history({ from, to, sources?, accountKeys?, limitIds?, granularity?, pageSize?, cursor?, includeRaw? })`: Paginated raw or aggregated observations and data quality.
- `get_status({ sources? })`: Service health, source capabilities, errors and retry deadlines.
- `get_usage_history({ sources? })`: Legacy seven-day charts plus JSON.
- `get_all_quotas({ sources?: string[] })`: Returns a list of quota snapshots for the requested sources (or all enabled sources if omitted).
- `refresh({ sources?: string[] })`: Submits asynchronous collection to the local service, respecting cooldown and merging concurrent requests.

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
| `npm run smoke` | Reads service health and cached observations without contacting providers |
| `npm run report` | Renders recorded history as a self-contained HTML report |
| `npm run login gemini-web` | Same as `quotacheck login gemini-web`: saves the Gemini session for Playwright |

---

## macOS Menu Bar App

`quotacheck-mcp` ships with a native, lightweight macOS Menu Bar app built in SwiftUI.

> [!NOTE]
> The app runs inside your menu bar as an agent (`LSUIElement` in `Info.plist`). It only
> reads what the background service stores, by running `quotacheck legacy` every 30
> seconds while the panel is open; the refresh button also asks the service to collect.
> It finds `quotacheck` through your login shell's `PATH`, so nvm, volta, fnm and asdf
> installs work.

### Build and Run

```bash
macos/build.sh
open macos/Quotacheck.app
```

If the default macOS 27 SDK reports a missing `SwiftUIMacros.StateMacro`, pass an
installed compatible SDK through `SWIFTC_FLAGS`:

```bash
SWIFTC_FLAGS="-sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk -target arm64-apple-macosx15.0" macos/build.sh
```

### Collapsible Accordion UI

Each provider in the macOS menu bar panel features a fold/unfold chevron button:
- **Expanded state**: Shows individual quota bars (Session, Weekly, Extra Usage) with custom percentage fills (coloring changes dynamically from blue to orange/red depending on utilization).
- **Collapsed state**: Minimizes the provider card, saving screen space when monitoring multiple sources.
- Animated using native SwiftUI transition styles.

---

## Troubleshooting

### Gemini Session Expired
Errors such as `Session expired` or `Not signed in — /usage redirected to /app` mean the saved Google session is no longer valid. Run `quotacheck login gemini-web` again; the service retries hourly, or immediately on a manual refresh.

### Claude Code Quota Unavailable
- `Claude Code is signed out. Run claude to sign in again`: run `claude` and sign in; the next manual refresh (after a minute) or the hourly retry picks it up.
- `This Claude login has no plan limits`: the engine is signed in with an API key or a third-party platform, which has no subscription limits to report.
- `Claude Code engine (claude command) not found`: install Claude Code, or make sure the service's PATH reaches it (run `quotacheck install-service` again after changing Node).

### Codex Rate Limits Unavailable
```
`codex app-server` reported no rate limit window. Is the Codex CLI signed in?
```
Run `codex login` (or `codex doctor`) and confirm the account is a plan that meters Codex usage. An API-key-only login has no rate-limit snapshot to report.

After switching Codex accounts, the next collection reads the new account. If a collection ran mid-switch and failed authentication, press refresh in the menu bar (or run `quotacheck refresh --sources codex`) rather than waiting for the hourly retry. Each reading records which account it came from (a hash of the login email, never the email itself), so reports and `get_usage_history` show each Codex account separately, labelled like `m…@gmail.com · plus`.

### Antigravity Quota Unavailable
```
No quota rows in `agy -p /usage` or `agy -p /quota` output. Is the Antigravity CLI installed and signed in?
```
Check that `agy -p /usage --output-format json` (or `agy -p "/quota"` on older builds) prints the quota in a terminal. The service runs with the `PATH` recorded by `install-service` (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`); set `antigravityUsageBinary` to an absolute path if `agy` lives elsewhere.
