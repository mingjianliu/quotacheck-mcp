import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { type BrowserContext } from "playwright";

chromium.use(StealthPlugin());

const STEALTH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function getJitteredViewport() {
  return {
    width: 1280 + Math.floor(Math.random() * 10) - 5, // 1275-1285
    height: 720 + Math.floor(Math.random() * 10) - 5, // 715-725
  };
}

/**
 * Launch a headless browser whose session is restored from a Playwright
 * storageState file (produced by `quotacheck login`). This is how authenticated
 * collectors stay signed in: the live Chrome profile is unusable headlessly
 * (it launches signed-out, so e.g. gemini.google.com/usage bounces to /app),
 * whereas a saved storageState carries the real cookies into a clean context.
 */
export async function launchAuthenticatedContext(
  sessionPath: string,
  options: { executablePath?: string; timeout: number },
): Promise<{ context: BrowserContext; cleanup: () => Promise<void> }> {
  const browser = await chromium.launch({
    headless: true,
    executablePath: options.executablePath,
    timeout: options.timeout,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    storageState: sessionPath,
    userAgent: STEALTH_USER_AGENT,
    viewport: getJitteredViewport(),
  });
  return { context, cleanup: () => browser.close() };
}
