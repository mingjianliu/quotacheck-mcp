# Stealth Browser Integration Design

**Date:** 2026-05-26
**Topic:** Stealth Browser Integration (Learning from OmniRoute)
**Status:** Draft

## Goal
Improve the robustness of web-based collectors (specifically `gemini-web` and future `claude-design`) by integrating industry-standard stealth and evasion logic to bypass bot detection (CAPTCHAs).

## Architecture

### 1. Unified Stealth Utility
We will refactor `src/utils/playwright.ts` to move from base Playwright to `playwright-extra`.

- **Library:** `playwright-extra` + `puppeteer-extra-plugin-stealth`
- **Pattern:** Approach 1 (Surgical Stealth Injection). The `chromium` instance exported by the utility will be pre-configured with the stealth plugin.
- **Scope:** Global. Every collector using `launchWithLockWorkaround` or the shared utility will automatically use stealth.

### 2. Fingerprinting & Evasion Logic
Beyond the plugin defaults, we will implement:
- **User-Agent:** Force a modern macOS Chrome string that aligns with the bundled Chromium version.
- **Automation Flags:** 
  - `--disable-blink-features=AutomationControlled`
  - `ignoreDefaultArgs: ['--enable-automation']`
- **Humanization:**
  - **Viewport Jitter:** Randomly vary the viewport dimensions by ±5px to avoid static bot signatures.
  - **Headers:** Ensure `Accept-Language` and `Sec-CH-UA` headers are present and consistent.
  - **Thought Delays:** Inject `200ms-800ms` randomized delays before critical navigations or interactions.

## Collector Integration

### Gemini Web
- Uses the stealth-enabled browser automatically.
- Detects `/sorry/index` (CAPTCHA) and reports it with clear instructions.
- No automatic headful pop-ups to avoid background process interruptions.

## Implementation Details

### Dependencies to Add
- `playwright-extra`
- `puppeteer-extra-plugin-stealth`

### File Changes
- `src/utils/playwright.ts`: Core refactor to use `playwright-extra`.
- `src/collectors/gemini-web.ts`: (Optional) Add humanization delays if still blocked after stealth integration.

## Testing & Success Criteria
- **Success:** Running `npm run smoke` (or the `gemini-web` collector) succeeds without triggering a CAPTCHA on a "warm" profile.
- **Failure Handling:** If blocked, a clear error message is surfaced instead of a generic timeout or empty result.
- **Regression:** Existing collectors (`antigravity`, `claude-code`) remain unaffected.
