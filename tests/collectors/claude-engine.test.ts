import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectClaudeCode } from "../../src/collectors/claude-code.js";
import { engineCandidates, parseControlResponse } from "../../src/collectors/claude-engine.js";

const ENGINE = join(process.cwd(), "tests", "fixtures", "fake-claude.mjs");
const homes: string[] = [];
afterEach(() => { homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true })); delete process.env.FAKE_CLAUDE_MODE; delete process.env.FAKE_CLAUDE_PROFILE; });

function home(profile?: unknown) {
  const h = mkdtempSync(join(tmpdir(), "qc-claude-"));
  homes.push(h);
  if (profile) writeFileSync(join(h, ".claude.json"), JSON.stringify(profile));
  return h;
}
const profile = { oauthAccount: { accountUuid: "acct-1", organizationUuid: "org-1", emailAddress: "someone@example.com" } };
const collect = (userHome: string, mode: string) => {
  process.env.FAKE_CLAUDE_MODE = mode;
  return collectClaudeCode({ engine: ENGINE, userHome, workDir: join(userHome, "engine"), now: new Date("2026-09-07T08:00:00Z") });
};

describe("Claude engine usage", () => {
  it("reads plan limits and the account from the engine's own login", async () => {
    const h = home(profile);
    const snap = await collect(h, "max");
    expect(snap.error).toBeUndefined();
    expect(snap.session?.pct).toBe(21);
    expect(snap.weekly?.pct).toBe(70);
    expect(snap.accountKey).toMatch(/^claude:[0-9a-f]{24}$/);
    expect(snap.extensions?.account).toEqual({ type: "claude", planType: "max", label: "s…@example.com · max" });
    expect(JSON.stringify(snap)).not.toContain("someone@");
  });

  it("tells a signed-out engine from a login without plan limits", async () => {
    expect((await collect(home(profile), "signed-out")).collectionError?.kind).toBe("authentication");
    expect((await collect(home(profile), "no-limits")).collectionError?.kind).toBe("unsupported");
  });

  it("discards a reading taken while the login changed", async () => {
    const h = home(profile);
    process.env.FAKE_CLAUDE_PROFILE = join(h, ".claude.json");
    const snap = await collect(h, "account-change");
    expect(snap.error).toMatch(/account changed/);
    expect(snap.session).toBeUndefined();
  });

  it("surfaces an engine error", async () => {
    expect((await collect(home(profile), "error")).error).toMatch(/boom/);
  });

  it("reports a missing engine off macOS instead of reaching for the Keychain", async () => {
    const snap = await collectClaudeCode({ engine: null, platform: "linux" });
    expect(snap.collectionError?.kind).toBe("unsupported");
  });

  it("ignores stream lines other than the control response", () => {
    expect(parseControlResponse('{"type":"system","subtype":"init"}')).toBeUndefined();
    expect(parseControlResponse("not json control_response")).toBeUndefined();
  });

  it("looks for the native installer's newest version", () => {
    const h = home();
    mkdirSync(join(h, ".local", "share", "claude", "versions"), { recursive: true });
    for (const v of ["2.1.9", "2.1.10"]) writeFileSync(join(h, ".local", "share", "claude", "versions", v), "");
    const list = engineCandidates(h, "");
    expect(list.indexOf(join(h, ".local", "share", "claude", "versions", "2.1.10"))).toBeLessThan(list.indexOf(join(h, ".local", "share", "claude", "versions", "2.1.9")));
  });
});
