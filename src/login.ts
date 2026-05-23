#!/usr/bin/env node
/**
 * One-time login helper. Opens a headed browser so the user can authenticate,
 * then saves a Playwright storageState JSON that the collectors reuse on every
 * subsequent headless run.
 *
 * Usage:
 *   npx tsx src/login.ts claude-design
 *   npx tsx src/login.ts gemini-web
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SOURCES = {
  "claude-design": {
    startUrl: "https://claude.ai/login",
    readyUrl: (url: URL) =>
      url.hostname === "claude.ai" && !url.pathname.startsWith("/login"),
    sessionFile: "claude-design-session.json",
    instructions:
      "Log in to claude.ai. Once you reach any page other than /login the session will be saved automatically.",
  },
  "gemini-web": {
    startUrl: "https://gemini.google.com",
    readyUrl: (url: URL) => url.hostname === "gemini.google.com",
    sessionFile: "gemini-web-session.json",
    instructions:
      "Log in with your Google account. Once the Gemini page loads the session will be saved automatically.",
  },
} as const;

async function main() {
  const source = process.argv[2] as keyof typeof SOURCES | undefined;
  if (!source || !(source in SOURCES)) {
    console.error(`Usage: login <source>`);
    console.error(`Available: ${Object.keys(SOURCES).join(", ")}`);
    process.exit(1);
  }

  const cfg = SOURCES[source];
  const sessionDir = join(homedir(), ".config", "quotacheck-mcp");
  const sessionPath = join(sessionDir, cfg.sessionFile);

  mkdirSync(sessionDir, { recursive: true });

  console.log(`\nOpening browser for ${source}…`);
  console.log(`${cfg.instructions}\n`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(cfg.startUrl);

  await page.waitForURL(cfg.readyUrl, { timeout: 300_000 });

  const state = await context.storageState();
  writeFileSync(sessionPath, JSON.stringify(state, null, 2));
  console.log(`\nSession saved → ${sessionPath}`);
  console.log(`You can now run: npx quotacheck-mcp`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
