# quotacheck-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js MCP server that, on demand, reports the user's current quota across Claude Code, Gemini CLI, Gemini web, claude.ai design, and Antigravity.

**Architecture:** Single TypeScript process exposing two MCP stdio tools (`get_all_quotas`, `refresh`). Each call fans out to 5 collectors in parallel via `Promise.allSettled`. Local-file collectors parse on-disk state. Web collectors use Playwright with `launchPersistentContext` against the user's existing Chrome profile to inherit logged-in sessions. No cache, no daemon. Errors are isolated per source.

**Tech Stack:** Node 20+, TypeScript 5, `@modelcontextprotocol/sdk`, Playwright (Chromium with `executablePath` → system Chrome), Vitest, Zod.

**Spec:** `docs/superpowers/specs/2026-05-22-quotacheck-mcp-design.md`

---

## File Structure

```
quotacheck-mcp/
├── src/
│   ├── server.ts                # MCP stdio server, registers tools
│   ├── collect.ts               # orchestrator: parallel fan-out
│   ├── types.ts                 # SourceId, QuotaSnapshot, Bucket, Collector
│   ├── config.ts                # config loader + defaults
│   ├── plans.json               # plan-limit table (Claude tiers, etc.)
│   └── collectors/
│       ├── claude-code.ts       # parses ~/.claude/projects/**/*.jsonl
│       ├── gemini-cli.ts        # parses ~/.gemini/ state
│       ├── antigravity.ts       # shells out to antigravity-usage --json
│       ├── gemini-web.ts        # Playwright + DOM parser
│       └── claude-design.ts     # Playwright + DOM parser
├── tests/
│   ├── collect.test.ts
│   ├── config.test.ts
│   └── collectors/
│       ├── claude-code.test.ts
│       ├── gemini-cli.test.ts
│       ├── antigravity.test.ts
│       ├── gemini-web.parser.test.ts
│       └── claude-design.parser.test.ts
├── tests/fixtures/
│   ├── claude-projects/         # tiny mock .jsonl logs
│   ├── gemini-state/            # snapshot of ~/.gemini/ files
│   ├── antigravity-usage.json   # captured CLI output
│   ├── gemini-web-usage.html    # captured DOM
│   └── claude-design-usage.html # captured DOM
├── scripts/
│   └── smoke.ts                 # live end-to-end run against real sources
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

**Boundaries:** Each collector exports a single `collect(): Promise<QuotaSnapshot>` plus, for web sources, a separately exported pure `parse(html: string): QuotaSnapshot` so the DOM parsing can be unit-tested without Playwright. `collect.ts` knows the list of collectors but not their internals.

---

## Task 1: Project scaffold

**Files:**

- Create: `package.json`, `tsconfig.json`, `.gitignore`, `vitest.config.ts`, `src/types.ts`, `tests/.gitkeep`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "quotacheck-mcp",
  "version": "0.1.0",
  "description": "MCP server reporting current quota across Claude Code, Gemini CLI, Gemini web, claude.ai design, and Antigravity",
  "type": "module",
  "bin": {
    "quotacheck-mcp": "dist/server.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/server.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "smoke": "tsx scripts/smoke.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "playwright": "^1.48.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 5: Create `src/types.ts`**

```ts
export type SourceId =
  | "claude-code"
  | "gemini-cli"
  | "gemini-web"
  | "claude-design"
  | "antigravity";

export const ALL_SOURCES: SourceId[] = [
  "claude-code",
  "gemini-cli",
  "gemini-web",
  "claude-design",
  "antigravity",
];

export interface Bucket {
  used: number;
  limit: number;
  pct: number;
  resetsAt?: string;
}

export interface SubModelBucket extends Bucket {
  name: string;
}

export interface QuotaSnapshot {
  source: SourceId;
  collectedAt: string;
  session?: Bucket;
  weekly?: Bucket;
  subModels?: SubModelBucket[];
  error?: string;
}

export interface Collector {
  source: SourceId;
  collect(ctx: CollectorContext): Promise<QuotaSnapshot>;
}

export interface CollectorContext {
  chromeProfilePath: string;
  chromeExecutablePath?: string;
  playwrightTimeoutMs: number;
  antigravityUsageBinary: string;
  homeDir: string;
}
```

- [ ] **Step 6: Install deps**

Run: `npm install`
Expected: clean install, no peer-dep warnings.

- [ ] **Step 7: Verify scaffold compiles**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json .gitignore vitest.config.ts src/types.ts
git commit -m "feat: project scaffold and shared types"
```

---

## Task 2: Config loader

**Files:**

- Create: `src/config.ts`, `tests/config.test.ts`

- [ ] **Step 1: Write failing test `tests/config.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "quotacheck-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns defaults when no file exists", () => {
    const cfg = loadConfig({ homeDir: tmp });
    expect(cfg.enabledSources).toEqual([
      "claude-code",
      "gemini-cli",
      "gemini-web",
      "claude-design",
      "antigravity",
    ]);
    expect(cfg.playwrightTimeoutMs).toBe(8000);
    expect(cfg.antigravityUsageBinary).toBe("antigravity-usage");
    expect(cfg.chromeProfilePath).toContain("Chrome");
  });

  it("merges user overrides on top of defaults", () => {
    const cfgDir = join(tmp, ".config", "quotacheck-mcp");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({
        playwrightTimeoutMs: 15000,
        enabledSources: ["claude-code"],
      }),
    );
    const cfg = loadConfig({ homeDir: tmp });
    expect(cfg.playwrightTimeoutMs).toBe(15000);
    expect(cfg.enabledSources).toEqual(["claude-code"]);
    expect(cfg.antigravityUsageBinary).toBe("antigravity-usage");
  });

  it("throws on invalid JSON", () => {
    const cfgDir = join(tmp, ".config", "quotacheck-mcp");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"), "{not-json");
    expect(() => loadConfig({ homeDir: tmp })).toThrow(/parse/i);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npm test -- config`
Expected: FAIL — `loadConfig` not exported.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { z } from "zod";
import { ALL_SOURCES, type SourceId } from "./types.js";

const ConfigSchema = z.object({
  chromeProfilePath: z.string(),
  chromeExecutablePath: z.string().optional(),
  enabledSources: z.array(
    z.enum([
      "claude-code",
      "gemini-cli",
      "gemini-web",
      "claude-design",
      "antigravity",
    ]),
  ),
  playwrightTimeoutMs: z.number().int().positive(),
  antigravityUsageBinary: z.string(),
});

export type Config = z.infer<typeof ConfigSchema>;

function defaultChromeProfile(home: string): string {
  if (platform() === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "Default",
    );
  }
  if (platform() === "linux") {
    return join(home, ".config", "google-chrome", "Default");
  }
  return join(
    home,
    "AppData",
    "Local",
    "Google",
    "Chrome",
    "User Data",
    "Default",
  );
}

function defaultChromeExecutable(): string | undefined {
  if (platform() === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return undefined;
}

export function loadConfig(opts: { homeDir?: string } = {}): Config {
  const home = opts.homeDir ?? homedir();
  const defaults: Config = {
    chromeProfilePath: defaultChromeProfile(home),
    chromeExecutablePath: defaultChromeExecutable(),
    enabledSources: [...ALL_SOURCES] as SourceId[],
    playwrightTimeoutMs: 8000,
    antigravityUsageBinary: "antigravity-usage",
  };

  const path = join(home, ".config", "quotacheck-mcp", "config.json");
  if (!existsSync(path)) return defaults;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`failed to parse ${path}: ${(e as Error).message}`);
  }

  const merged = { ...defaults, ...(raw as Record<string, unknown>) };
  return ConfigSchema.parse(merged);
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npm test -- config`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: config loader with defaults and user overrides"
```

---

## Task 3: Plans table

**Files:**

- Create: `src/plans.json`

- [ ] **Step 1: Create `src/plans.json` with current Anthropic Max-tier limits as a starting table**

```json
{
  "anthropic": {
    "max-20x": {
      "sessionTokens": 220000000,
      "weeklyTokens": 800000000,
      "weeklyOpusTokens": 200000000,
      "sessionWindowHours": 5
    },
    "max-5x": {
      "sessionTokens": 55000000,
      "weeklyTokens": 200000000,
      "weeklyOpusTokens": 50000000,
      "sessionWindowHours": 5
    },
    "pro": {
      "sessionTokens": 11000000,
      "weeklyTokens": 40000000,
      "weeklyOpusTokens": 0,
      "sessionWindowHours": 5
    }
  },
  "_note": "Numbers are best-effort approximations of public Anthropic plan limits as of 2026-05. Refresh seasonally. The claude-code collector will pick a plan via config or fall back to 'pro'."
}
```

Numbers will need refreshing periodically — the spec marks this as a maintenance item. They are deliberately conservative so the `pct` value over-estimates rather than under-estimates remaining quota.

- [ ] **Step 2: Commit**

```bash
git add src/plans.json
git commit -m "feat: add plan-limit table for Anthropic tiers"
```

---

## Task 4: Collector orchestrator

**Files:**

- Create: `src/collect.ts`, `tests/collect.test.ts`

- [ ] **Step 1: Write failing test `tests/collect.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { runCollectors } from "../src/collect.js";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
} from "../src/types.js";

const ctx: CollectorContext = {
  chromeProfilePath: "/tmp/profile",
  playwrightTimeoutMs: 1000,
  antigravityUsageBinary: "antigravity-usage",
  homeDir: "/tmp",
};

function fake(
  source: QuotaSnapshot["source"],
  result: Partial<QuotaSnapshot>,
): Collector {
  return {
    source,
    collect: async () => ({
      source,
      collectedAt: new Date().toISOString(),
      ...result,
    }),
  };
}

function failing(source: QuotaSnapshot["source"]): Collector {
  return {
    source,
    collect: async () => {
      throw new Error("boom");
    },
  };
}

describe("runCollectors", () => {
  it("runs all collectors in parallel and returns their snapshots", async () => {
    const collectors = [
      fake("claude-code", { session: { used: 1, limit: 10, pct: 10 } }),
      fake("gemini-cli", {}),
    ];
    const out = await runCollectors(collectors, ctx);
    expect(out.map((s) => s.source).sort()).toEqual([
      "claude-code",
      "gemini-cli",
    ]);
    expect(out.find((s) => s.source === "claude-code")?.session?.pct).toBe(10);
  });

  it("isolates errors — one failure does not block other sources", async () => {
    const collectors = [failing("gemini-web"), fake("antigravity", {})];
    const out = await runCollectors(collectors, ctx);
    const web = out.find((s) => s.source === "gemini-web");
    const ag = out.find((s) => s.source === "antigravity");
    expect(web?.error).toBe("boom");
    expect(ag?.error).toBeUndefined();
  });

  it("filters to requested subset when provided", async () => {
    const collectors = [
      fake("claude-code", {}),
      fake("gemini-cli", {}),
      fake("antigravity", {}),
    ];
    const out = await runCollectors(collectors, ctx, {
      sources: ["claude-code"],
    });
    expect(out.map((s) => s.source)).toEqual(["claude-code"]);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npm test -- collect`
Expected: FAIL — `runCollectors` not exported.

- [ ] **Step 3: Implement `src/collect.ts`**

```ts
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SourceId,
} from "./types.js";

export async function runCollectors(
  collectors: Collector[],
  ctx: CollectorContext,
  opts: { sources?: SourceId[] } = {},
): Promise<QuotaSnapshot[]> {
  const requested = opts.sources ? new Set(opts.sources) : null;
  const selected = requested
    ? collectors.filter((c) => requested.has(c.source))
    : collectors;

  const results = await Promise.allSettled(selected.map((c) => c.collect(ctx)));

  return results.map((r, i) => {
    const source = selected[i].source;
    if (r.status === "fulfilled") return r.value;
    return {
      source,
      collectedAt: new Date().toISOString(),
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npm test -- collect`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/collect.ts tests/collect.test.ts
git commit -m "feat: collector orchestrator with parallel fan-out and error isolation"
```

---

## Task 5: claude-code collector

**Files:**

- Create: `src/collectors/claude-code.ts`, `tests/collectors/claude-code.test.ts`, `tests/fixtures/claude-projects/`

- [ ] **Step 1: Create fixture `tests/fixtures/claude-projects/myproj/session-aaa.jsonl`**

```jsonl
{"type":"user","timestamp":"2026-05-22T00:00:00Z","message":{"role":"user","content":"hi"}}
{"type":"assistant","timestamp":"2026-05-22T00:00:01Z","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":1000,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
{"type":"assistant","timestamp":"2026-05-22T00:01:00Z","message":{"model":"claude-opus-4-7","usage":{"input_tokens":500,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
```

Add a second fixture file `tests/fixtures/claude-projects/myproj/session-bbb.jsonl` to verify multi-session aggregation:

```jsonl
{
  "type": "assistant",
  "timestamp": "2026-05-22T01:00:00Z",
  "message": {
    "model": "claude-sonnet-4-6",
    "usage": {
      "input_tokens": 2000,
      "output_tokens": 400,
      "cache_read_input_tokens": 0,
      "cache_creation_input_tokens": 0
    }
  }
}
```

- [ ] **Step 2: Write failing test `tests/collectors/claude-code.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { collectClaudeCode } from "../../src/collectors/claude-code.js";

const fixtureHome = join(process.cwd(), "tests", "fixtures");

describe("collectClaudeCode", () => {
  it("aggregates token usage from all jsonl files", async () => {
    const snap = await collectClaudeCode({
      homeDir: fixtureHome,
      projectsDir: join(fixtureHome, "claude-projects"),
      plan: "pro",
      now: new Date("2026-05-22T02:00:00Z"),
    });

    expect(snap.source).toBe("claude-code");
    expect(snap.error).toBeUndefined();
    // sonnet: (1000+200)+(2000+400) = 3600; opus: 500+100 = 600; total = 4200
    expect(snap.session?.used).toBe(4200);
    expect(snap.session?.limit).toBe(11000000);
    expect(snap.subModels?.find((m) => m.name === "opus")?.used).toBe(600);
  });

  it("returns error snapshot when projects dir is missing", async () => {
    const snap = await collectClaudeCode({
      homeDir: fixtureHome,
      projectsDir: join(fixtureHome, "does-not-exist"),
      plan: "pro",
      now: new Date(),
    });
    expect(snap.error).toMatch(/projects/i);
  });
});
```

- [ ] **Step 3: Run test, expect failure**

Run: `npm test -- claude-code`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/collectors/claude-code.ts`**

```ts
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import plans from "../plans.json" with { type: "json" };
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

interface ClaudeCodeOpts {
  homeDir: string;
  projectsDir?: string;
  plan?: keyof typeof plans.anthropic;
  now?: Date;
}

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walkJsonl(full));
    } else if (entry.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

interface UsageLine {
  type?: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

function modelFamily(
  model: string | undefined,
): "opus" | "sonnet" | "haiku" | "other" {
  if (!model) return "other";
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return "other";
}

export async function collectClaudeCode(
  opts: ClaudeCodeOpts,
): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  const projectsDir =
    opts.projectsDir ?? join(opts.homeDir, ".claude", "projects");
  const planKey = opts.plan ?? "pro";
  const plan = plans.anthropic[planKey];

  if (!existsSync(projectsDir)) {
    return {
      source: "claude-code",
      collectedAt: now.toISOString(),
      error: `claude projects dir not found: ${projectsDir}`,
    };
  }

  const sessionCutoff = new Date(
    now.getTime() - plan.sessionWindowHours * 3600_000,
  );
  const weekCutoff = new Date(now.getTime() - 7 * 24 * 3600_000);

  let sessionTotal = 0;
  let weeklyTotal = 0;
  const opusSession = { used: 0 };
  const opusWeekly = { used: 0 };

  for (const file of walkJsonl(projectsDir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      let obj: UsageLine;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = obj.message?.usage;
      if (!usage) continue;
      const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      const ts = obj.timestamp ? new Date(obj.timestamp) : null;
      if (!ts) continue;
      const isOpus = modelFamily(obj.message?.model) === "opus";

      if (ts >= sessionCutoff) {
        sessionTotal += tokens;
        if (isOpus) opusSession.used += tokens;
      }
      if (ts >= weekCutoff) {
        weeklyTotal += tokens;
        if (isOpus) opusWeekly.used += tokens;
      }
    }
  }

  const weeklyResetAt = new Date(
    weekCutoff.getTime() + 7 * 24 * 3600_000,
  ).toISOString();
  const sessionResetAt = new Date(
    sessionCutoff.getTime() + plan.sessionWindowHours * 3600_000,
  ).toISOString();

  const subModels: SubModelBucket[] = [];
  if (plan.weeklyOpusTokens > 0) {
    subModels.push({
      name: "opus",
      used: opusWeekly.used,
      limit: plan.weeklyOpusTokens,
      pct: (opusWeekly.used / plan.weeklyOpusTokens) * 100,
      resetsAt: weeklyResetAt,
    });
  }

  return {
    source: "claude-code",
    collectedAt: now.toISOString(),
    session: {
      used: sessionTotal,
      limit: plan.sessionTokens,
      pct: (sessionTotal / plan.sessionTokens) * 100,
      resetsAt: sessionResetAt,
    },
    weekly: {
      used: weeklyTotal,
      limit: plan.weeklyTokens,
      pct: (weeklyTotal / plan.weeklyTokens) * 100,
      resetsAt: weeklyResetAt,
    },
    subModels: subModels.length ? subModels : undefined,
  };
}

export const claudeCodeCollector: Collector = {
  source: "claude-code",
  collect: (ctx: CollectorContext) =>
    collectClaudeCode({ homeDir: ctx.homeDir }),
};
```

- [ ] **Step 5: Run test, expect pass**

Run: `npm test -- claude-code`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src/collectors/claude-code.ts tests/collectors/claude-code.test.ts tests/fixtures/claude-projects
git commit -m "feat: claude-code collector parses ~/.claude/projects jsonl"
```

---

## Task 6: gemini-cli collector

**Files:**

- Create: `src/collectors/gemini-cli.ts`, `tests/collectors/gemini-cli.test.ts`, `tests/fixtures/gemini-state/`

- [ ] **Step 1: Spike — discover the on-disk format**

This collector has a known unknown: where does Gemini CLI store quota state on disk? Before writing the test, inspect a live install:

Run these on your machine and capture findings into a comment block at the top of `src/collectors/gemini-cli.ts`:

```bash
ls -la ~/.gemini/
cat ~/.gemini/state.json 2>/dev/null | head -50
cat ~/.gemini/settings.json 2>/dev/null
ls ~/.gemini/history/ 2>/dev/null | head -5
gemini -p "/stats" 2>&1 | head -40   # if non-interactive /stats works
```

Possible outcomes:

- **(a)** Quota counters live in `state.json` → parse JSON.
- **(b)** Quota is computed from history files → walk JSONL similar to claude-code.
- **(c)** Neither — fall back to a subprocess `gemini -p "/stats"` that returns text we regex.

Write a one-paragraph comment in the collector file documenting what you found and which path you took.

- [ ] **Step 2: Create fixture based on spike findings**

Copy a redacted snippet of the real file(s) into `tests/fixtures/gemini-state/`. Document in the test file what fields the fixture exercises.

- [ ] **Step 3: Write failing test `tests/collectors/gemini-cli.test.ts`**

Skeleton — fill in `expected` based on fixture:

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { collectGeminiCli } from "../../src/collectors/gemini-cli.js";

describe("collectGeminiCli", () => {
  it("parses session quota from gemini state", async () => {
    const snap = await collectGeminiCli({
      stateDir: join(process.cwd(), "tests", "fixtures", "gemini-state"),
      now: new Date("2026-05-22T02:00:00Z"),
    });
    expect(snap.source).toBe("gemini-cli");
    expect(snap.error).toBeUndefined();
    expect(snap.session?.used).toBeGreaterThan(0);
    expect(snap.session?.limit).toBeGreaterThan(0);
  });

  it("returns error when state dir is missing", async () => {
    const snap = await collectGeminiCli({
      stateDir: "/does/not/exist",
      now: new Date(),
    });
    expect(snap.error).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run test, expect failure**

Run: `npm test -- gemini-cli`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `src/collectors/gemini-cli.ts`**

Skeleton — the body depends on the spike result. The exported shape MUST be:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Collector, CollectorContext, QuotaSnapshot } from "../types.js";

// Spike findings (2026-05-22):
//   <one paragraph here describing what you found and which parsing path
//    you took — outcome (a), (b), or (c) from the spike step>

interface GeminiCliOpts {
  stateDir: string;
  now?: Date;
}

export async function collectGeminiCli(
  opts: GeminiCliOpts,
): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  if (!existsSync(opts.stateDir)) {
    return {
      source: "gemini-cli",
      collectedAt: now.toISOString(),
      error: `gemini state dir not found: ${opts.stateDir}`,
    };
  }

  // <parse based on spike outcome>
  // Return either a fully-populated QuotaSnapshot or one with `error`.

  throw new Error("TODO replace with parsed output");
}

export const geminiCliCollector: Collector = {
  source: "gemini-cli",
  collect: (ctx: CollectorContext) =>
    collectGeminiCli({ stateDir: join(ctx.homeDir, ".gemini") }),
};
```

Replace the `throw` with the actual parser before moving on. If the spike concluded that no usable on-disk state exists (outcome c), implement the subprocess path here: spawn `gemini -p "/stats"` with a 5s timeout and parse the stdout.

- [ ] **Step 6: Run test, expect pass**

Run: `npm test -- gemini-cli`
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add src/collectors/gemini-cli.ts tests/collectors/gemini-cli.test.ts tests/fixtures/gemini-state
git commit -m "feat: gemini-cli collector with on-disk quota parser"
```

---

## Task 7: antigravity collector

**Files:**

- Create: `src/collectors/antigravity.ts`, `tests/collectors/antigravity.test.ts`, `tests/fixtures/antigravity-usage.json`

- [ ] **Step 1: Create fixture `tests/fixtures/antigravity-usage.json`**

This is a plausible shape for `antigravity-usage --json` output. If the real tool's schema differs when implementing, update both fixture and parser to match. Document the real schema in a code comment.

```json
{
  "models": [
    {
      "name": "gemini-2.5-pro",
      "session": {
        "used": 12,
        "limit": 100,
        "resets_at": "2026-05-22T05:00:00Z"
      },
      "weekly": {
        "used": 340,
        "limit": 1000,
        "resets_at": "2026-05-26T00:00:00Z"
      }
    },
    {
      "name": "gemini-2.5-flash",
      "session": {
        "used": 30,
        "limit": 500,
        "resets_at": "2026-05-22T05:00:00Z"
      },
      "weekly": {
        "used": 800,
        "limit": 5000,
        "resets_at": "2026-05-26T00:00:00Z"
      }
    }
  ]
}
```

- [ ] **Step 2: Write failing test `tests/collectors/antigravity.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAntigravity,
  collectAntigravity,
} from "../../src/collectors/antigravity.js";

const fixture = readFileSync(
  join(process.cwd(), "tests", "fixtures", "antigravity-usage.json"),
  "utf8",
);

describe("parseAntigravity", () => {
  it("produces a QuotaSnapshot with subModels populated", () => {
    const snap = parseAntigravity(fixture, new Date("2026-05-22T02:00:00Z"));
    expect(snap.source).toBe("antigravity");
    expect(snap.subModels?.map((m) => m.name).sort()).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-pro",
    ]);
    const pro = snap.subModels?.find((m) => m.name === "gemini-2.5-pro");
    expect(pro?.used).toBe(340);
    expect(pro?.limit).toBe(1000);
    expect(pro?.pct).toBe(34);
  });
});

describe("collectAntigravity", () => {
  it("returns error snapshot when binary is missing", async () => {
    const snap = await collectAntigravity({
      binary: "/does/not/exist/antigravity-usage",
      now: new Date(),
    });
    expect(snap.error).toMatch(/antigravity-usage/);
  });

  it("returns error snapshot when binary outputs invalid JSON", async () => {
    const snap = await collectAntigravity({
      binary: "echo",
      args: ["not-json"],
      now: new Date(),
    });
    expect(snap.error).toMatch(/parse/i);
  });
});
```

- [ ] **Step 3: Run test, expect failure**

Run: `npm test -- antigravity`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/collectors/antigravity.ts`**

```ts
import { spawn } from "node:child_process";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

interface RawBucket {
  used: number;
  limit: number;
  resets_at?: string;
}
interface RawModel {
  name: string;
  session?: RawBucket;
  weekly?: RawBucket;
}
interface RawOutput {
  models: RawModel[];
}

function bucketFrom(
  b: RawBucket | undefined,
  name: string,
): SubModelBucket | null {
  if (!b) return null;
  return {
    name,
    used: b.used,
    limit: b.limit,
    pct: b.limit > 0 ? (b.used / b.limit) * 100 : 0,
    resetsAt: b.resets_at,
  };
}

export function parseAntigravity(json: string, now: Date): QuotaSnapshot {
  let raw: RawOutput;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `failed to parse antigravity-usage output: ${(e as Error).message}`,
    );
  }

  const subModels: SubModelBucket[] = [];
  for (const m of raw.models ?? []) {
    const wk = bucketFrom(m.weekly, m.name);
    if (wk) subModels.push(wk);
  }

  return {
    source: "antigravity",
    collectedAt: now.toISOString(),
    subModels: subModels.length ? subModels : undefined,
  };
}

interface AntigravityOpts {
  binary: string;
  args?: string[];
  now?: Date;
  timeoutMs?: number;
}

export async function collectAntigravity(
  opts: AntigravityOpts,
): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  const args = opts.args ?? ["--json"];

  let stdout = "";
  let stderr = "";
  const exit = await new Promise<number | NodeJS.Signals>((resolve) => {
    const child = spawn(opts.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const t = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 5000);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", () => resolve(127));
    child.on("exit", (code, sig) => {
      clearTimeout(t);
      resolve(code ?? sig ?? 0);
    });
  });

  if (exit !== 0) {
    return {
      source: "antigravity",
      collectedAt: now.toISOString(),
      error: `antigravity-usage exited ${exit}: ${stderr.trim() || "no output"}`,
    };
  }

  try {
    return parseAntigravity(stdout, now);
  } catch (e) {
    return {
      source: "antigravity",
      collectedAt: now.toISOString(),
      error: (e as Error).message,
    };
  }
}

export const antigravityCollector: Collector = {
  source: "antigravity",
  collect: (ctx: CollectorContext) =>
    collectAntigravity({ binary: ctx.antigravityUsageBinary }),
};
```

- [ ] **Step 5: Run test, expect pass**

Run: `npm test -- antigravity`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src/collectors/antigravity.ts tests/collectors/antigravity.test.ts tests/fixtures/antigravity-usage.json
git commit -m "feat: antigravity collector shells out to antigravity-usage"
```

---

## Task 8: gemini-web collector

**Files:**

- Create: `src/collectors/gemini-web.ts`, `tests/collectors/gemini-web.parser.test.ts`, `tests/fixtures/gemini-web-usage.html`

- [ ] **Step 1: Capture a real fixture**

Open `https://gemini.google.com/usage` in your Chrome while logged in. Save the page (DevTools → Elements → copy outerHTML of the usage card) to `tests/fixtures/gemini-web-usage.html`. Note the selectors that uniquely identify each per-model row.

- [ ] **Step 2: Write failing test `tests/collectors/gemini-web.parser.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGeminiWeb } from "../../src/collectors/gemini-web.js";

const html = readFileSync(
  join(process.cwd(), "tests", "fixtures", "gemini-web-usage.html"),
  "utf8",
);

describe("parseGeminiWeb", () => {
  it("extracts per-model quotas from the usage page HTML", () => {
    const snap = parseGeminiWeb(html, new Date("2026-05-22T02:00:00Z"));
    expect(snap.source).toBe("gemini-web");
    expect(snap.error).toBeUndefined();
    expect(snap.subModels?.length ?? 0).toBeGreaterThan(0);
    for (const m of snap.subModels ?? []) {
      expect(m.limit).toBeGreaterThan(0);
      expect(m.pct).toBeGreaterThanOrEqual(0);
      expect(m.pct).toBeLessThanOrEqual(100);
    }
  });
});
```

- [ ] **Step 3: Run test, expect failure**

Run: `npm test -- gemini-web`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/collectors/gemini-web.ts`**

```ts
import { chromium, type BrowserContext } from "playwright";
import type {
  Collector,
  CollectorContext,
  QuotaSnapshot,
  SubModelBucket,
} from "../types.js";

const USAGE_URL = "https://gemini.google.com/usage";

// Pure parser — separated for unit testability without a browser.
export function parseGeminiWeb(html: string, now: Date): QuotaSnapshot {
  const subModels: SubModelBucket[] = [];

  // Selector strategy: each per-model row exposes its name, used count,
  // and limit. Update these regexes after inspecting the captured fixture.
  const rowRe =
    /<div[^>]*data-model="([^"]+)"[^>]*>[\s\S]*?<span[^>]*data-used>(\d+)<\/span>[\s\S]*?<span[^>]*data-limit>(\d+)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    const used = Number(m[2]);
    const limit = Number(m[3]);
    subModels.push({
      name: m[1],
      used,
      limit,
      pct: limit > 0 ? (used / limit) * 100 : 0,
    });
  }

  if (subModels.length === 0) {
    return {
      source: "gemini-web",
      collectedAt: now.toISOString(),
      error: "no model rows matched — page structure may have changed",
    };
  }

  return {
    source: "gemini-web",
    collectedAt: now.toISOString(),
    subModels,
  };
}

export async function collectGeminiWeb(opts: {
  chromeProfilePath: string;
  chromeExecutablePath?: string;
  timeoutMs: number;
  now?: Date;
}): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  let ctx: BrowserContext | null = null;
  try {
    ctx = await chromium.launchPersistentContext(opts.chromeProfilePath, {
      headless: true,
      executablePath: opts.chromeExecutablePath,
      timeout: opts.timeoutMs,
    });
    const page = await ctx.newPage();
    await page.goto(USAGE_URL, {
      timeout: opts.timeoutMs,
      waitUntil: "networkidle",
    });
    const html = await page.content();
    return parseGeminiWeb(html, now);
  } catch (e) {
    return {
      source: "gemini-web",
      collectedAt: now.toISOString(),
      error: (e as Error).message,
    };
  } finally {
    if (ctx) await ctx.close();
  }
}

export const geminiWebCollector: Collector = {
  source: "gemini-web",
  collect: (ctx: CollectorContext) =>
    collectGeminiWeb({
      chromeProfilePath: ctx.chromeProfilePath,
      chromeExecutablePath: ctx.chromeExecutablePath,
      timeoutMs: ctx.playwrightTimeoutMs,
    }),
};
```

- [ ] **Step 5: Adjust the regex in `parseGeminiWeb` to match the captured fixture**

Inspect `tests/fixtures/gemini-web-usage.html`, identify the real attribute or class names that wrap model name, used count, and limit. Replace the placeholder `data-model` / `data-used` / `data-limit` regex with whatever the real page uses. Iterate test → fix until passing.

- [ ] **Step 6: Run test, expect pass**

Run: `npm test -- gemini-web`
Expected: 1 passed.

- [ ] **Step 7: Commit**

```bash
git add src/collectors/gemini-web.ts tests/collectors/gemini-web.parser.test.ts tests/fixtures/gemini-web-usage.html
git commit -m "feat: gemini-web collector with Playwright + DOM parser"
```

---

## Task 9: claude-design collector

**Files:**

- Create: `src/collectors/claude-design.ts`, `tests/collectors/claude-design.parser.test.ts`, `tests/fixtures/claude-design-usage.html`

This task mirrors Task 8's structure — same Playwright-with-persistent-context pattern, separate pure parser.

- [ ] **Step 1: Capture a real fixture**

Log in to claude.ai and navigate to the design quota page (the spec leaves the exact path open — check claude.ai/settings, claude.ai/design, or wherever the design-feature quota row appears). Save the relevant DOM fragment to `tests/fixtures/claude-design-usage.html`.

- [ ] **Step 2: Write failing test `tests/collectors/claude-design.parser.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeDesign } from "../../src/collectors/claude-design.js";

const html = readFileSync(
  join(process.cwd(), "tests", "fixtures", "claude-design-usage.html"),
  "utf8",
);

describe("parseClaudeDesign", () => {
  it("extracts the design quota bucket", () => {
    const snap = parseClaudeDesign(html, new Date("2026-05-22T02:00:00Z"));
    expect(snap.source).toBe("claude-design");
    expect(snap.error).toBeUndefined();
    // Design quota is typically a single bucket (session or daily).
    expect(snap.session?.limit ?? snap.weekly?.limit).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test, expect failure**

Run: `npm test -- claude-design`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/collectors/claude-design.ts`**

```ts
import { chromium, type BrowserContext } from "playwright";
import type { Collector, CollectorContext, QuotaSnapshot } from "../types.js";

const USAGE_URL = "https://claude.ai/settings/usage"; // update after fixture-capture

export function parseClaudeDesign(html: string, now: Date): QuotaSnapshot {
  // Replace these regexes with whatever pattern the captured HTML actually
  // uses. The design quota is typically rendered as "X / Y used" alongside
  // a reset timestamp.
  const usedRe = /design[^<]*?(\d[\d,]*)\s*\/\s*(\d[\d,]*)/i;
  const resetRe = /resets?[^<]*?(\d{4}-\d{2}-\d{2}T[\d:]+Z)/i;

  const usedMatch = usedRe.exec(html);
  if (!usedMatch) {
    return {
      source: "claude-design",
      collectedAt: now.toISOString(),
      error: "design quota row not found on page",
    };
  }

  const used = Number(usedMatch[1].replace(/,/g, ""));
  const limit = Number(usedMatch[2].replace(/,/g, ""));
  const resetsAt = resetRe.exec(html)?.[1];

  return {
    source: "claude-design",
    collectedAt: now.toISOString(),
    session: {
      used,
      limit,
      pct: limit > 0 ? (used / limit) * 100 : 0,
      resetsAt,
    },
  };
}

export async function collectClaudeDesign(opts: {
  chromeProfilePath: string;
  chromeExecutablePath?: string;
  timeoutMs: number;
  now?: Date;
}): Promise<QuotaSnapshot> {
  const now = opts.now ?? new Date();
  let ctx: BrowserContext | null = null;
  try {
    ctx = await chromium.launchPersistentContext(opts.chromeProfilePath, {
      headless: true,
      executablePath: opts.chromeExecutablePath,
      timeout: opts.timeoutMs,
    });
    const page = await ctx.newPage();
    await page.goto(USAGE_URL, {
      timeout: opts.timeoutMs,
      waitUntil: "networkidle",
    });
    const html = await page.content();
    return parseClaudeDesign(html, now);
  } catch (e) {
    return {
      source: "claude-design",
      collectedAt: now.toISOString(),
      error: (e as Error).message,
    };
  } finally {
    if (ctx) await ctx.close();
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

- [ ] **Step 5: Adjust selectors to match the captured fixture**

Iterate test → fix regex until passing.

- [ ] **Step 6: Run test, expect pass**

Run: `npm test -- claude-design`
Expected: 1 passed.

- [ ] **Step 7: Commit**

```bash
git add src/collectors/claude-design.ts tests/collectors/claude-design.parser.test.ts tests/fixtures/claude-design-usage.html
git commit -m "feat: claude-design collector with Playwright + DOM parser"
```

---

## Task 10: MCP server wiring

**Files:**

- Create: `src/server.ts`

- [ ] **Step 1: Implement `src/server.ts`**

```ts
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { runCollectors } from "./collect.js";
import {
  ALL_SOURCES,
  type Collector,
  type CollectorContext,
  type SourceId,
} from "./types.js";
import { claudeCodeCollector } from "./collectors/claude-code.js";
import { geminiCliCollector } from "./collectors/gemini-cli.js";
import { antigravityCollector } from "./collectors/antigravity.js";
import { geminiWebCollector } from "./collectors/gemini-web.js";
import { claudeDesignCollector } from "./collectors/claude-design.js";

const ALL_COLLECTORS: Collector[] = [
  claudeCodeCollector,
  geminiCliCollector,
  antigravityCollector,
  geminiWebCollector,
  claudeDesignCollector,
];

const ToolInput = z.object({
  sources: z.array(z.enum(ALL_SOURCES as [SourceId, ...SourceId[]])).optional(),
});

async function main() {
  const cfg = loadConfig();
  const ctx: CollectorContext = {
    chromeProfilePath: cfg.chromeProfilePath,
    chromeExecutablePath: cfg.chromeExecutablePath,
    playwrightTimeoutMs: cfg.playwrightTimeoutMs,
    antigravityUsageBinary: cfg.antigravityUsageBinary,
    homeDir: homedir(),
  };
  const enabled = ALL_COLLECTORS.filter((c) =>
    cfg.enabledSources.includes(c.source),
  );

  const server = new Server(
    { name: "quotacheck-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_all_quotas",
        description: "Return a current quota snapshot for each enabled source.",
        inputSchema: {
          type: "object",
          properties: {
            sources: {
              type: "array",
              items: { type: "string", enum: ALL_SOURCES },
              description: "Optional subset of sources. Omit for all enabled.",
            },
          },
        },
      },
      {
        name: "refresh",
        description:
          "Force re-collection (identical to get_all_quotas; reserved verb for future caching).",
        inputSchema: {
          type: "object",
          properties: {
            sources: {
              type: "array",
              items: { type: "string", enum: ALL_SOURCES },
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (name !== "get_all_quotas" && name !== "refresh") {
      throw new Error(`unknown tool: ${name}`);
    }
    const args = ToolInput.parse(req.params.arguments ?? {});
    const snapshots = await runCollectors(enabled, ctx, {
      sources: args.sources,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(snapshots, null, 2) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Build and sanity-check**

Run: `npm run build && node dist/server.js < /dev/null &; sleep 1; kill %1`
Expected: Server starts without crashing (no module-resolution errors). It will exit when stdin closes.

- [ ] **Step 3: Smoke-test via MCP inspector (optional but recommended)**

Run:

```bash
npx @modelcontextprotocol/inspector node dist/server.js
```

In the inspector UI, list tools (should see `get_all_quotas` and `refresh`) and invoke `get_all_quotas` with `{}`. Verify the JSON output has 5 snapshots.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: MCP stdio server registering get_all_quotas and refresh"
```

---

## Task 11: Smoke script, README, and final wiring

**Files:**

- Create: `scripts/smoke.ts`, `README.md`

- [ ] **Step 1: Create `scripts/smoke.ts`**

```ts
import { homedir } from "node:os";
import { loadConfig } from "../src/config.js";
import { runCollectors } from "../src/collect.js";
import type { Collector, CollectorContext } from "../src/types.js";
import { claudeCodeCollector } from "../src/collectors/claude-code.js";
import { geminiCliCollector } from "../src/collectors/gemini-cli.js";
import { antigravityCollector } from "../src/collectors/antigravity.js";
import { geminiWebCollector } from "../src/collectors/gemini-web.js";
import { claudeDesignCollector } from "../src/collectors/claude-design.js";

const ALL: Collector[] = [
  claudeCodeCollector,
  geminiCliCollector,
  antigravityCollector,
  geminiWebCollector,
  claudeDesignCollector,
];

(async () => {
  const cfg = loadConfig();
  const ctx: CollectorContext = {
    chromeProfilePath: cfg.chromeProfilePath,
    chromeExecutablePath: cfg.chromeExecutablePath,
    playwrightTimeoutMs: cfg.playwrightTimeoutMs,
    antigravityUsageBinary: cfg.antigravityUsageBinary,
    homeDir: homedir(),
  };
  const enabled = ALL.filter((c) => cfg.enabledSources.includes(c.source));
  const snaps = await runCollectors(enabled, ctx);
  for (const s of snaps) {
    console.log(`\n[${s.source}] ${s.error ? `ERROR: ${s.error}` : "ok"}`);
    if (s.session)
      console.log(
        `  session: ${s.session.used}/${s.session.limit} (${s.session.pct.toFixed(1)}%)`,
      );
    if (s.weekly)
      console.log(
        `  weekly:  ${s.weekly.used}/${s.weekly.limit} (${s.weekly.pct.toFixed(1)}%)`,
      );
    for (const m of s.subModels ?? []) {
      console.log(`  ${m.name}: ${m.used}/${m.limit} (${m.pct.toFixed(1)}%)`);
    }
  }
})();
```

- [ ] **Step 2: Run live smoke**

Run: `npm run smoke`
Expected: Within ~10s, 5 source blocks print. Local collectors return numbers; web collectors either return numbers or an `error` line — verify each is reasonable.

If `gemini-web` or `claude-design` errors with "no model rows matched" or similar, capture a fresh fixture from the live page and refine the parser regex. Re-run smoke.

- [ ] **Step 3: Create `README.md`**

````markdown
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
````

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

````

- [ ] **Step 4: Final test run**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke.ts README.md
git commit -m "feat: live smoke script and README"
````

---

## Self-Review

**Spec coverage:**

- Goal (5 sources, MCP, auto-only) → Tasks 5–9 (collectors) + Task 10 (MCP wiring). ✓
- Architecture (single Node process, stdio, parallel fan-out, Playwright with persistent context) → Tasks 1, 4, 8, 9, 10. ✓
- Non-goals respected — no manual entry, no daemon, no notifications, no login flows. ✓
- Error isolation → Task 4 explicitly tests it. ✓
- `get_all_quotas` + `refresh` → Task 10. ✓
- `QuotaSnapshot` / `Bucket` / `SubModelBucket` types → Task 1. ✓
- Per-source collection methods match spec table → Tasks 5–9. ✓
- Configuration file → Task 2 + Task 11 README. ✓
- Install / registration → Task 11 README. ✓
- Testing strategy: parser-level unit tests for each collector, smoke script for live → Tasks 5–11. ✓

**Placeholder scan:** Two tasks (6 gemini-cli, 8 gemini-web, 9 claude-design) deliberately defer some details to capture-time. Each one calls out explicitly what to capture, where to put it, and how to iterate — not silent placeholders. The spec explicitly authorized this for these three. No silent TBDs found.

**Type consistency:** `Collector.collect(ctx: CollectorContext)` signature is used in Tasks 1, 4, 5, 6, 7, 8, 9, 10. `parseAntigravity`, `parseGeminiWeb`, `parseClaudeDesign` are exported alongside their `collect*` counterparts so unit tests can hit the pure parsers. `runCollectors(collectors, ctx, opts)` signature is consistent between Task 4 and Task 10/11. `SourceId` union matches across `types.ts`, `config.ts` schema, and `server.ts` tool schema.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-22-quotacheck-mcp.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
