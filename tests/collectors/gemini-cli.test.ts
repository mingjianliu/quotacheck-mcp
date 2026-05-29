import { describe, it, expect, vi, beforeEach } from "vitest";
import { collectGeminiCli } from "../../src/collectors/gemini-cli.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { request } from "node:https";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("node:https", () => ({
  request: vi.fn(),
}));

describe("collectGeminiCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes token, fetches quota from API, and parses buckets", async () => {
    // Mock fs for oauth_creds.json
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      access_token: "expired",
      refresh_token: "fake-refresh-token",
      expiry_date: 1 // Expired but truthy
    }));
    vi.mocked(existsSync).mockReturnValue(true);

    // We expect two HTTPS requests: 1. token refresh, 2. retrieveUserQuota
    let requestCount = 0;

    vi.mocked(request).mockImplementation((options, callback) => {
      requestCount++;
      const path = (options as any).path || "";
      const isRefresh = path.includes("token");
      const isLoadCodeAssist = path.includes("loadCodeAssist");

      const mockRes = {
        statusCode: 200,
        on: vi.fn((event, handler) => {
          if (event === "data") {
            if (isRefresh) {
              handler(JSON.stringify({
                access_token: "new-access-token",
                expires_in: 3600
              }));
            } else if (isLoadCodeAssist) {
              handler(JSON.stringify({
                cloudaicompanionProject: "fake-project-123"
              }));
            } else {
              handler(JSON.stringify({
                buckets: [
                  {
                    modelId: "gemini-2.5-flash",
                    remainingFraction: 0.20,
                    resetTime: "2026-05-23T00:00:00Z"
                  },
                  {
                    modelId: "gemini-2.5-pro",
                    remainingFraction: 0,
                    resetTime: "2026-05-23T00:00:00Z"
                  }
                ]
              }));
            }
          }
          if (event === "end") handler();
        })
      };

      if (callback) callback(mockRes as any);

      return {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn()
      } as any;
    });

    const snap = await collectGeminiCli({ homeDir: "/fake/home" } as any);
    expect(snap.source).toBe("gemini-cli");
    expect(snap.error).toBeUndefined();
    expect(snap.subModels?.length).toBe(2);
    expect(snap.subModels?.find(m => m.name === "Gemini 2.5 Flash")?.used).toBe(80);
    expect(snap.subModels?.find(m => m.name === "Gemini 2.5 Pro")?.used).toBe(100);
    expect(writeFileSync).toHaveBeenCalled(); // Token was refreshed and saved
  });

  it("sorts sub-models alphabetically by name", async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      access_token: "valid",
      refresh_token: "fake-refresh-token",
      expiry_date: Date.now() + 100000
    }));
    vi.mocked(existsSync).mockReturnValue(true);

    vi.mocked(request).mockImplementation((options, callback) => {
      const path = (options as any).path || "";
      const isLoadCodeAssist = path.includes("loadCodeAssist");

      const mockRes = {
        statusCode: 200,
        on: vi.fn((event, handler) => {
          if (event === "data") {
            if (isLoadCodeAssist) {
              handler(JSON.stringify({ cloudaicompanionProject: "fake-project" }));
            } else {
              handler(JSON.stringify({
                buckets: [
                  { modelId: "gemini-2.5-pro", remainingFraction: 0.5 },
                  { modelId: "gemini-2.5-flash", remainingFraction: 0.5 }
                ]
              }));
            }
          }
          if (event === "end") handler();
        })
      };
      if (callback) callback(mockRes as any);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const snap = await collectGeminiCli({ homeDir: "/fake/home" } as any);
    expect(snap.subModels).toBeDefined();
    const names = snap.subModels?.map(m => m.name);
    expect(names).toEqual(["Gemini 2.5 Flash", "Gemini 2.5 Pro"]);
  });

  it("returns error snapshot when oauth_creds.json is missing", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const snap = await collectGeminiCli({ homeDir: "/fake/home" } as any);
    expect(snap.source).toBe("gemini-cli");
    expect(snap.error).toMatch(/gemini credentials not found/i);
  });

  it("returns error snapshot when API request fails", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      access_token: "valid",
      refresh_token: "fake-refresh-token",
      expiry_date: Date.now() + 100000 // Valid
    }));

    const mockReq = {
      on: vi.fn((event, handler) => {
        if (event === "error") handler(new Error("Network Error"));
      }),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn()
    };

    vi.mocked(request).mockReturnValue(mockReq as any);

    const snap = await collectGeminiCli({ homeDir: "/fake/home" } as any);
    expect(snap.source).toBe("gemini-cli");
    expect(snap.error).toMatch(/Network Error/);
  });
});
