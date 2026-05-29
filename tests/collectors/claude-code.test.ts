import { describe, it, expect, vi, beforeEach } from "vitest";
import { collectClaudeCode } from "../../src/collectors/claude-code.js";
import { execFile } from "node:child_process";
import { request } from "node:https";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:https", () => ({
  request: vi.fn(),
}));

describe("collectClaudeCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches usage from Anthropic API and parses buckets", async () => {
    // Mock execFile for keychain token
    vi.mocked(execFile).mockImplementation((cmd, args, opts, callback) => {
      const cb = (typeof opts === "function" ? opts : callback) as any;
      cb(
        null,
        JSON.stringify({ claudeAiOauth: { accessToken: "fake-token" } }),
        "",
      );
      return {} as any;
    });

    // Mock https request
    const mockRes = {
      statusCode: 200,
      on: vi.fn((event, handler) => {
        if (event === "data") {
          handler(
            JSON.stringify({
              five_hour: { utilization: 10, resets_at: "2026-05-23T00:00:00Z" },
              seven_day: { utilization: 20, resets_at: "2026-05-24T00:00:00Z" },
              seven_day_opus: {
                utilization: 30,
                resets_at: "2026-05-24T00:00:00Z",
              },
              extra_usage: {
                is_enabled: true,
                monthly_limit: 2000,
                used_credits: 500,
                utilization: 25,
                currency: "USD",
              },
            }),
          );
        }
        if (event === "end") handler();
      }),
    };

    const mockReq = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };

    vi.mocked(request).mockImplementation((options, callback) => {
      if (callback) callback(mockRes as any);
      return mockReq as any;
    });

    const snap = await collectClaudeCode();
    expect(snap.source).toBe("claude-code");
    expect(snap.error).toBeUndefined();
    expect(snap.session?.used).toBe(10);
    expect(snap.weekly?.used).toBe(20);
    expect(snap.subModels?.find((m) => m.name === "opus")?.used).toBe(30);
    expect(
      snap.subModels?.find((m) => m.name === "extra_usage_USD")?.used,
    ).toBe(500);
    expect(
      snap.subModels?.find((m) => m.name === "extra_usage_USD")?.limit,
    ).toBe(2000);
  });

  it("returns error snapshot when keychain token is missing", async () => {
    vi.mocked(execFile).mockImplementation((cmd, args, opts, callback) => {
      const cb = (typeof opts === "function" ? opts : callback) as any;
      cb(new Error("Keychain error"), "", "Keychain error");
      return {} as any;
    });

    const snap = await collectClaudeCode();
    expect(snap.source).toBe("claude-code");
    expect(snap.error).toMatch(/keychain error/i);
  });

  it("returns error snapshot when API rate limits", async () => {
    vi.mocked(execFile).mockImplementation((cmd, args, opts, callback) => {
      const cb = (typeof opts === "function" ? opts : callback) as any;
      cb(
        null,
        JSON.stringify({ claudeAiOauth: { accessToken: "fake-token" } }),
        "",
      );
      return {} as any;
    });

    const mockRes = {
      statusCode: 429,
      headers: { "retry-after": "39" },
      on: vi.fn((event, handler) => {
        if (event === "data")
          handler(JSON.stringify({ error: { message: "Rate limited" } }));
        if (event === "end") handler();
      }),
    };

    const mockReq = {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };

    vi.mocked(request).mockImplementation((options, callback) => {
      if (callback) callback(mockRes as any);
      return mockReq as any;
    });

    const snap = await collectClaudeCode();
    expect(snap.source).toBe("claude-code");
    expect(snap.error).toMatch(/HTTP 429/);
  });

  it("does NOT retry/hammer on 429 — the endpoint escalates the penalty per request", async () => {
    vi.mocked(execFile).mockImplementation((cmd, args, opts, callback) => {
      const cb = (typeof opts === "function" ? opts : callback) as any;
      cb(
        null,
        JSON.stringify({ claudeAiOauth: { accessToken: "fake-token" } }),
        "",
      );
      return {} as any;
    });

    const mockRes = {
      statusCode: 429,
      headers: { "retry-after": "39" },
      on: vi.fn((event, handler) => {
        if (event === "data")
          handler(JSON.stringify({ error: { message: "Rate limited" } }));
        if (event === "end") handler();
      }),
    };
    const mockReq = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };

    vi.mocked(request).mockImplementation((options, callback) => {
      if (callback) callback(mockRes as any);
      return mockReq as any;
    });

    const snap = await collectClaudeCode();
    expect(snap.error).toMatch(/HTTP 429/);
    // Each request while rate-limited extends the lockout, so we must make exactly one.
    expect(vi.mocked(request)).toHaveBeenCalledTimes(1);
    // Surface the server's retry-after so callers know when to try again.
    expect(snap.error).toMatch(/39/);
  });
});
