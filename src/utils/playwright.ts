import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { type BrowserContext } from "playwright";
import { cpSync, existsSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

chromium.use(StealthPlugin());

function getJitteredViewport() {
  return {
    width: 1280 + Math.floor(Math.random() * 10) - 5, // 1275-1285
    height: 720 + Math.floor(Math.random() * 10) - 5, // 715-725
  };
}

export async function launchWithLockWorkaround(
  profilePath: string,
  options: {
    executablePath?: string;
    timeout: number;
  },
): Promise<{ context: BrowserContext; cleanup: () => void }> {
  try {
    // Try launching normally first
    const context = await chromium.launchPersistentContext(profilePath, {
      headless: true,
      executablePath: options.executablePath,
      timeout: options.timeout,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain", "--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
      viewport: getJitteredViewport(),
    });
    return { context, cleanup: () => context.close() };
  } catch (e) {
    const err = e as Error;
    const errorMsg = err.message;
    if (
      err.name === "TimeoutError" ||
      errorMsg.includes("Timeout") ||
      errorMsg.includes("Failed to create a ProcessSingleton") ||
      errorMsg.includes("SingletonLock") ||
      errorMsg.includes("Opening in existing browser session")
    ) {
      console.log(
        `Chrome profile locked or timed out, attempting workaround for ${profilePath}...`,
      );

      // Workaround: Copy essential parts of the profile to a temporary directory
      const tmpProfile = mkdtempSync(join(tmpdir(), "quotacheck-profile-"));
      const destDefault = join(tmpProfile, "Default");
      mkdirSync(destDefault, { recursive: true });

      const filesToCopy = [
        {
          src: join(profilePath, "Local State"),
          dest: join(tmpProfile, "Local State"),
        },
        {
          src: join(profilePath, "Default", "Cookies"),
          dest: join(destDefault, "Cookies"),
        },
        {
          src: join(profilePath, "Default", "Preferences"),
          dest: join(destDefault, "Preferences"),
        },
        {
          src: join(profilePath, "Default", "Local Storage"),
          dest: join(destDefault, "Local Storage"),
        },
        {
          src: join(profilePath, "Default", "Session Storage"),
          dest: join(destDefault, "Session Storage"),
        },
        {
          src: join(profilePath, "Default", "IndexedDB"),
          dest: join(destDefault, "IndexedDB"),
        },
      ];

      for (const f of filesToCopy) {
        if (existsSync(f.src)) {
          try {
            cpSync(f.src, f.dest, { recursive: true });
          } catch (cpErr) {
            console.warn(
              `Failed to copy ${f.src}: ${(cpErr as Error).message}`,
            );
          }
        }
      }

      const context = await chromium.launchPersistentContext(tmpProfile, {
        headless: true,
        executablePath: options.executablePath,
        timeout: options.timeout,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain", "--enable-automation"],
        args: ["--disable-blink-features=AutomationControlled"],
        viewport: getJitteredViewport(),
      });

      return {
        context,
        cleanup: async () => {
          await context.close();
          try {
            rmSync(tmpProfile, { recursive: true, force: true });
          } catch (rmErr) {
            console.warn(
              `Failed to cleanup temp profile ${tmpProfile}: ${(rmErr as Error).message}`,
            );
          }
        },
      };
    }
    throw e;
  }
}
