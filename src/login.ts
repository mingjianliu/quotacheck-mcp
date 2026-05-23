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
    // Navigate straight to the authenticated page so we only save state when
    // the user is actually logged in. If not logged in they'll see the login
    // form; after sign-in claude.ai redirects back to /settings.
    startUrl: "https://claude.ai/settings/usage",
    readyUrl: (url: URL) =>
      url.hostname === "claude.ai" && url.pathname.startsWith("/settings"),
    sessionFile: "claude-design-session.json",
    instructions: [
      "A browser window will open at claude.ai/settings/usage.",
      "If you see a login page, sign in.",
      "If you're redirected to the home page after sign-in, navigate to:",
      "  https://claude.ai/settings/usage",
      "The window closes automatically once you reach the settings page.",
    ].join("\n"),
  },
  "gemini-web": {
    startUrl: "https://gemini.google.com/usage",
    readyUrl: (url: URL) =>
      url.hostname === "gemini.google.com" &&
      !url.hostname.includes("accounts.google.com"),
    sessionFile: "gemini-web-session.json",
    instructions: [
      "A browser window will open at gemini.google.com/usage.",
      "If you see a Google sign-in prompt, sign in.",
      "The window closes automatically once the Gemini usage page loads.",
    ].join("\n"),
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

  // waitForURL fires on transient URLs too (before JS redirects run).
  // Loop: wait for the URL to hit the target, then confirm it's stable after
  // networkidle (no pending client-side redirect to /login).
  const deadline = Date.now() + 300_000;
  while (true) {
    if (Date.now() > deadline)
      throw new Error("Login timed out after 5 minutes");

    try {
      await page.waitForURL(cfg.readyUrl, { timeout: 10_000 });
    } catch {
      continue; // URL didn't match yet — keep waiting
    }

    try {
      await page.waitForLoadState("networkidle", { timeout: 10_000 });
    } catch {
      /* ignore — just check the URL */
    }

    if (cfg.readyUrl(new URL(page.url()))) break; // stable, authenticated
    // URL drifted (e.g. JS redirected to /login) — loop and wait again
  }

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
