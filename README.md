# quotacheck-mcp

An MCP server that reports your current AI-tool quota in one call, across:

- Claude Code (parses `~/.claude/projects`)
- Gemini CLI (parses `~/.gemini/`)
- Antigravity (shells out to `antigravity-usage --json`)
- Gemini web (Playwright → `gemini.google.com/usage`, reusing your Chrome login)
- claude.ai design (Playwright → `claude.ai`, reusing your Chrome login)

No cache, no daemon. Each call fans out to all 5 sources in parallel.

## Install

```bash
git clone <repo> quotacheck-mcp
cd quotacheck-mcp
npm install
npm run build
```

### Soft dependencies

- `antigravity-usage` CLI (for the Antigravity source). Install per its README; otherwise that one source returns an error snapshot.
- Google Chrome installed at the default path (Playwright reuses your profile via `executablePath`).

## Register with Claude Code

```bash
claude mcp add quotacheck -- node /absolute/path/to/quotacheck-mcp/dist/server.js
```

## Config

`~/.config/quotacheck-mcp/config.json` — optional, all keys default sensibly:

```json
{
  "chromeProfilePath": "/Users/you/Library/Application Support/Google/Chrome/Default",
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

## Tools

- `get_all_quotas({ sources?: SourceId[] })` — current snapshot per source.
- `refresh({ sources?: SourceId[] })` — same as above; reserved verb for future caching.

## Dev

```bash
npm test         # unit tests
npm run smoke    # live end-to-end against your real sources
npm run dev      # run server via tsx (stdio)
```
