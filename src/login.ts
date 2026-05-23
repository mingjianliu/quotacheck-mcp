#!/usr/bin/env node
/**
 * One-time login helper. Opens a headed browser so the user can authenticate,
 * then saves a Playwright storageState JSON that the collectors reuse on every
 * subsequent headless run.
 *
 * Usage:
 *   npx tsx src/login.ts gemini-web
 */
import { chromium } from "playwright";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

function detectChrome(): string | undefined {
  if (platform() === "darwin") {
    const p = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    return existsSync(p) ? p : undefined;
  }
  if (platform() === "linux") {
    for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium-browser"]) {
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const SOURCES = {
  "gemini-web": {
    startUrl: "https://gemini.google.com/usage",
    readyUrl: (url: URL) =>
      url.hostname === "gemini.google.com" && url.pathname === "/usage",
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

  const chromePath = detectChrome();
  if (chromePath) {
    console.log(`Using Chrome at: ${chromePath}`);
  } else {
    console.log(
      "System Chrome not found — using Playwright's Chromium (may hit bot detection)",
    );
  }

  const browser = await chromium.launch({
    headless: false,
    executablePath: chromePath,
    // Suppress automation fingerprints so Cloudflare doesn't block the login
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(cfg.startUrl);

  // waitForURL fires on transient URLs too (before JS redirects run).
  // Stability check: once the URL matches, wait 3 s for any JS redirect to
  // fire. If the URL changes away, loop. If it stays, we're authenticated.
  const deadline = Date.now() + 300_000;
  while (true) {
    if (Date.now() > deadline)
      throw new Error("Login timed out after 5 minutes");

    try {
      await page.waitForURL(cfg.readyUrl, { timeout: 10_000 });
    } catch {
      continue; // URL didn't match yet — keep waiting
    }

    // Watch for the URL to drift *away* from the target within 3 s.
    // If it does, a JS auth-redirect fired and we need to loop again.
    let drifted = false;
    try {
      await page.waitForURL((u) => !cfg.readyUrl(u), { timeout: 3_000 });
      drifted = true;
    } catch {
      // No drift within 3 s → URL is stable at the target
    }
    if (!drifted) break; // authenticated!
    // URL drifted (e.g. JS redirected to /login) — keep waiting
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
