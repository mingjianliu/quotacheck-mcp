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
      "antigravity",
    ]);
    expect(cfg.playwrightTimeoutMs).toBe(8000);
    expect(cfg.antigravityUsageBinary).toBe("agy");
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
    expect(cfg.antigravityUsageBinary).toBe("agy");
  });

  it("throws on invalid JSON", () => {
    const cfgDir = join(tmp, ".config", "quotacheck-mcp");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"), "{not-json");
    expect(() => loadConfig({ homeDir: tmp })).toThrow(/parse/i);
  });
});
