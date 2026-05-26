# Stealth Browser Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve browser collector robustness by integrating `playwright-extra` and the `stealth` plugin to bypass bot detection.

**Architecture:** Refactor `src/utils/playwright.ts` to use `playwright-extra` as the primary browser launcher. Apply the `stealth` plugin globally and add manual fingerprint jitter (viewport, user-agent) and behavioral humanization (delays).

**Tech Stack:** Playwright, `playwright-extra`, `puppeteer-extra-plugin-stealth`, TypeScript.

---

## Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the stealth libraries**

Run: `npm install playwright-extra puppeteer-extra-plugin-stealth`

- [ ] **Step 2: Verify installation**

Check `package.json` for the new entries.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add playwright-extra and stealth plugin dependencies"
```

---

## Task 2: Refactor `src/utils/playwright.ts` to use Stealth

**Files:**
- Modify: `src/utils/playwright.ts`

- [ ] **Step 1: Update imports and initialize stealth**

Replace standard `chromium` import with `playwright-extra`.

```typescript
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { type BrowserContext } from "playwright";
// ... other imports

chromium.use(StealthPlugin());
```

- [ ] **Step 2: Add viewport jitter logic**

Create a helper to get a slightly randomized viewport.

```typescript
function getJitteredViewport() {
  return {
    width: 1280 + Math.floor(Math.random() * 10) - 5, // 1275-1285
    height: 720 + Math.floor(Math.random() * 10) - 5, // 715-725
  };
}
```

- [ ] **Step 3: Update `launchWithLockWorkaround` to use stealth and jitter**

Update both the primary launch and the temp-profile fallback launch.

```typescript
// Inside launchWithLockWorkaround
const viewport = getJitteredViewport();
const context = await chromium.launchPersistentContext(profilePath, {
  headless: true,
  executablePath: options.executablePath,
  timeout: options.timeout,
  viewport: viewport,
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain", "--enable-automation"],
  args: ["--disable-blink-features=AutomationControlled"],
});
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/playwright.ts
git commit -m "feat: refactor playwright utility to use stealth plugin and viewport jitter"
```

---

## Task 3: Add Humanization Delays to Gemini Web

**Files:**
- Modify: `src/collectors/gemini-web.ts`

- [ ] **Step 1: Add randomized delay helper**

```typescript
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));
const humanDelay = () => delay(200 + Math.random() * 600);
```

- [ ] **Step 2: Inject delays before navigation and interaction**

In `collectGeminiWeb`, add `await humanDelay()` before `page.goto`.

```typescript
// ...
    const page = await context.newPage();
    // ... response listeners ...

    await humanDelay(); // Human-like pause before navigation
    try {
      await page.goto(USAGE_URL, {
        timeout: opts.timeoutMs,
        waitUntil: "load",
      });
// ...
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/collectors/gemini-web.ts
git commit -m "feat: add human-like delays to gemini-web collector"
```

---

## Task 4: Final Verification

- [ ] **Step 1: Run smoke test**

Run: `npx tsx scripts/smoke.ts`

- [ ] **Step 2: Update Mac App**

Run: `cd macos && ./build.sh && open Quotacheck.app`

- [ ] **Step 3: Final Commit**

```bash
git commit --allow-empty -m "chore: stealth browser integration complete"
```
