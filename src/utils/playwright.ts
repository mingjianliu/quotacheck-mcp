import { chromium, type BrowserContext } from "playwright";
import { cpSync, existsSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function launchWithLockWorkaround(
  profilePath: string,
  options: {
    executablePath?: string;
    timeout: number;
  }
): Promise<{ context: BrowserContext; cleanup: () => void }> {
  try {
    // Try launching normally first
    const context = await chromium.launchPersistentContext(profilePath, {
      headless: true,
      executablePath: options.executablePath,
      timeout: options.timeout,
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    });
    return { context, cleanup: () => context.close() };
  } catch (e) {
    const errorMsg = (e as Error).message;
    if (e.name === "TimeoutError" || errorMsg.includes("Timeout") || errorMsg.includes("Failed to create a ProcessSingleton") || errorMsg.includes("SingletonLock")) {
      console.log(`Chrome profile locked or timed out, attempting workaround for ${profilePath}...`);
      
      // Workaround: Copy essential parts of the profile to a temporary directory
      const tmpProfile = mkdtempSync(join(tmpdir(), "quotacheck-profile-"));
      const destDefault = join(tmpProfile, "Default");
      mkdirSync(destDefault, { recursive: true });

      const filesToCopy = [
        { src: join(profilePath, "Local State"), dest: join(tmpProfile, "Local State") },
        { src: join(profilePath, "Default", "Cookies"), dest: join(destDefault, "Cookies") },
        { src: join(profilePath, "Default", "Preferences"), dest: join(destDefault, "Preferences") },
        { src: join(profilePath, "Default", "Local Storage"), dest: join(destDefault, "Local Storage") },
        { src: join(profilePath, "Default", "Session Storage"), dest: join(destDefault, "Session Storage") },
        { src: join(profilePath, "Default", "IndexedDB"), dest: join(destDefault, "IndexedDB") },
      ];

      for (const f of filesToCopy) {
        if (existsSync(f.src)) {
          try {
            cpSync(f.src, f.dest, { recursive: true });
          } catch (cpErr) {
            console.warn(`Failed to copy ${f.src}: ${(cpErr as Error).message}`);
          }
        }
      }

      const context = await chromium.launchPersistentContext(tmpProfile, {
        headless: true,
        executablePath: options.executablePath,
        timeout: options.timeout,
        ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
      });

      return {
        context,
        cleanup: async () => {
          await context.close();
          try {
            rmSync(tmpProfile, { recursive: true, force: true });
          } catch (rmErr) {
            console.warn(`Failed to cleanup temp profile ${tmpProfile}: ${(rmErr as Error).message}`);
          }
        },
      };
    }
    throw e;
  }
}
