/**
 * One-time login helper. Opens a headed browser so the user can authenticate,
 * then saves a Playwright storageState JSON that the collectors reuse on every
 * subsequent headless run.
 *
 * Usage:
 *   quotacheck login gemini-web [--home PATH]
 */
import { chromium } from "playwright";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { dataDirectory, privateDirectory } from "./store.js";

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

export const LOGIN_SOURCES = Object.keys(SOURCES);

export async function login(source: string | undefined, home: string): Promise<string> {
  if (!source || !(source in SOURCES)) {
    throw new Error(`Usage: quotacheck login <source>. Available: ${LOGIN_SOURCES.join(", ")}`);
  }

  const cfg = SOURCES[source as keyof typeof SOURCES];
  // The session file holds Google cookies: keep it, and its directory, owner-only.
  const sessionDir = dataDirectory(home);
  const sessionPath = join(sessionDir, cfg.sessionFile);
  privateDirectory(sessionDir);

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
  try {
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
    writeFileSync(sessionPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    // `mode` only applies on creation; an older session file may be wider.
    chmodSync(sessionPath, 0o600);
    console.log(`\nSession saved → ${sessionPath}`);
    console.log("The background service picks it up on its next collection.");
    return sessionPath;
  } finally {
    await browser.close();
  }
}
