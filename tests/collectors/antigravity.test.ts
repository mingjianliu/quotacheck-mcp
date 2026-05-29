import { describe, it, expect, vi, beforeEach } from "vitest";
import { collectAntigravity } from "../../src/collectors/antigravity.js";
import { exec } from "node:child_process";
import { request } from "node:https";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

vi.mock("node:https", () => ({
  request: vi.fn(),
}));

describe("collectAntigravity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("produces a QuotaSnapshot with subModels populated", async () => {
    // Mock exec for ps aux and lsof/ss
    vi.mocked(exec).mockImplementation((cmd, opts, callback) => {
      const cb = (typeof opts === "function" ? opts : callback) as any;
      if (cmd.includes("ps aux")) {
        cb(null, "user 1234 0.0 0.0 123 456 ? S 00:00:00 language_server --csrf_token=fake-token", "");
      } else if (cmd.includes("lsof") || cmd.includes("ss")) {
        // Return fake ports
        cb(null, "127.0.0.1:9090", "");
      } else {
        cb(null, "", "");
      }
      return {} as any;
    });

    // Mock https request
    const mockRes = {
      statusCode: 200,
      on: vi.fn((event, handler) => {
        if (event === "data") {
          handler(JSON.stringify({
            userStatus: {
              cascadeModelConfigData: {
                clientModelConfigs: [
                  {
                    name: "gemini-2.5-flash",
                    quotaInfo: { remainingFraction: 0.66 }
                  },
                  {
                    name: "gemini-2.5-pro",
                    quotaInfo: { remainingFraction: 0 }
                  }
                ]
              }
            }
          }));
        }
        if (event === "end") {
          handler();
        }
      })
    };

    const mockReq = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn((cb: any) => {
        if (cb) cb();
      }),
      destroy: vi.fn()
    };

    vi.mocked(request).mockImplementation((options, callback) => {
      if (callback) callback(mockRes as any);
      return mockReq as any;
    });

    const snap = await collectAntigravity();
    expect(snap.source).toBe("antigravity");
    expect(snap.error).toBeUndefined();
    expect(snap.subModels?.length).toBe(2);
    expect(snap.subModels?.find(m => m.name === "gemini-2.5-flash")?.used).toBe(34);
    expect(snap.subModels?.find(m => m.name === "gemini-2.5-pro")?.used).toBe(100);
  });

  it("produces a QuotaSnapshot when 'agy' process is found without CSRF", async () => {
    // Mock exec for ps aux showing 'agy'
    vi.mocked(exec).mockImplementation((cmd, opts, callback) => {
      const cb = (typeof opts === "function" ? opts : callback) as any;
      if (cmd.includes("ps aux")) {
        cb(null, "user 53467 10.7 2.1 437723152 719792 s013 R+ 6:55PM 48:00.68 agy", "");
      } else if (cmd.includes("lsof") || cmd.includes("ss")) {
        cb(null, "127.0.0.1:61354", "");
      } else {
        cb(null, "", "");
      }
      return {} as any;
    });

    // Mock https request
    const mockRes = {
      statusCode: 200,
      on: vi.fn((event, handler) => {
        if (event === "data") {
          handler(JSON.stringify({
            userStatus: {
              cascadeModelConfigData: {
                clientModelConfigs: [
                  {
                    name: "agy-model",
                    quotaInfo: { remainingFraction: 0.5 }
                  }
                ]
              }
            }
          }));
        }
        if (event === "end") {
          handler();
        }
      })
    };

    const mockReq = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn((cb: any) => {
        if (cb) cb();
      }),
      destroy: vi.fn()
    };

    vi.mocked(request).mockImplementation((options, callback) => {
      if (callback) callback(mockRes as any);
      return mockReq as any;
    });

    const snap = await collectAntigravity();
    expect(snap.source).toBe("antigravity");
    expect(snap.error).toBeUndefined();
    expect(snap.subModels?.length).toBe(1);
    expect(snap.subModels?.[0].name).toBe("agy-model");
    expect(snap.subModels?.[0].used).toBe(50);
  });

  it("returns error when server info is not found", async () => {
    vi.mocked(exec).mockImplementation((cmd, opts, callback) => {
      const cb = (typeof opts === "function" ? opts : callback) as any;
      cb(null, "nothing interesting here", "");
      return {} as any;
    });

    const snap = await collectAntigravity();
    expect(snap.source).toBe("antigravity");
    expect(snap.error).toMatch(/Antigravity language server not found/);
  });

  it("returns error when gRPC request fails", async () => {
    vi.mocked(exec).mockImplementation((cmd, opts, callback) => {
      const cb = (typeof opts === "function" ? opts : callback) as any;
      if (cmd.includes("ps aux")) {
        cb(null, "user 1234 0.0 0.0 123 456 ? S 00:00:00 language_server --csrf_token=fake-token", "");
      } else if (cmd.includes("lsof") || cmd.includes("ss")) {
        cb(null, "127.0.0.1:9090", "");
      }
      return {} as any;
    });

    const mockReq = {
      on: vi.fn((event, handler) => {
        if (event === "error") handler(new Error("Network Error"));
      }),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn()
    };

    vi.mocked(request).mockReturnValue(mockReq as any);

    const snap = await collectAntigravity();
    expect(snap.source).toBe("antigravity");
    expect(snap.error).toMatch(/Network Error|Failed to contact/);
  });

  it("sorts subModels alphabetically by name", async () => {
    // Mock exec for ps aux showing 'agy'
    vi.mocked(exec).mockImplementation((cmd, opts, callback) => {
      const cb = (typeof opts === "function" ? opts : callback) as any;
      if (cmd.includes("ps aux")) {
        cb(null, "user 53467 10.7 2.1 437723152 719792 s013 R+ 6:55PM 48:00.68 agy", "");
      } else if (cmd.includes("lsof") || cmd.includes("ss")) {
        cb(null, "127.0.0.1:61354", "");
      } else {
        cb(null, "", "");
      }
      return {} as any;
    });

    // Mock https request with models in non-alphabetical order
    const mockRes = {
      statusCode: 200,
      on: vi.fn((event, handler) => {
        if (event === "data") {
          handler(JSON.stringify({
            userStatus: {
              cascadeModelConfigData: {
                clientModelConfigs: [
                  { name: "zebra", quotaInfo: { remainingFraction: 1 } },
                  { name: "apple", quotaInfo: { remainingFraction: 1 } },
                  { name: "mango", quotaInfo: { remainingFraction: 1 } }
                ]
              }
            }
          }));
        }
        if (event === "end") {
          handler();
        }
      })
    };

    const mockReq = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn((cb: any) => {
        if (cb) cb();
      }),
      destroy: vi.fn()
    };

    vi.mocked(request).mockImplementation((options, callback) => {
      if (callback) callback(mockRes as any);
      return mockReq as any;
    });

    const snap = await collectAntigravity();
    expect(snap.source).toBe("antigravity");
    expect(snap.subModels).toBeDefined();
    const names = snap.subModels!.map(m => m.name);
    expect(names).toEqual(["apple", "mango", "zebra"]);
  });
});
