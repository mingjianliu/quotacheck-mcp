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
