import { describe, expect, it } from "vitest";
import { assertSubscription, claudeStatus, type SpawnSyncLike } from "../src/status.js";

function fakeSpawnSync(auth: object | null, opts: { missing?: boolean } = {}) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const impl: SpawnSyncLike = (_bin, args, options) => {
    calls.push({ args, env: options.env });
    if (opts.missing) return { stdout: null, error: new Error("ENOENT") };
    if (args[0] === "--version") return { stdout: "2.1.49 (Claude Code)\n" };
    return { stdout: auth ? JSON.stringify(auth) : "" };
  };
  return { impl, calls };
}

describe("claudeStatus", () => {
  it("reads version, login, method and plan", () => {
    const { impl } = fakeSpawnSync({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "x@y.z" });
    expect(claudeStatus({ spawnSyncImpl: impl })).toEqual({
      installed: true,
      version: "2.1.49",
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "max",
    });
  });

  it("asks without the API key in the environment", () => {
    const { impl, calls } = fakeSpawnSync({ loggedIn: true, authMethod: "claude.ai" });
    claudeStatus({ spawnSyncImpl: impl, env: { ANTHROPIC_API_KEY: "k", PATH: "/bin" } });
    expect(calls.every((c) => c.env.ANTHROPIC_API_KEY === undefined)).toBe(true);
  });

  it("reports a missing CLI without throwing", () => {
    const { impl } = fakeSpawnSync(null, { missing: true });
    expect(claudeStatus({ spawnSyncImpl: impl })).toEqual({ installed: false, loggedIn: false });
  });

  it("treats unreadable auth output as signed out", () => {
    const { impl } = fakeSpawnSync(null);
    expect(claudeStatus({ spawnSyncImpl: impl }).loggedIn).toBe(false);
  });
});

describe("assertSubscription", () => {
  it("passes a claude.ai login", () => {
    expect(() => assertSubscription({ installed: true, loggedIn: true, authMethod: "claude.ai" })).not.toThrow();
  });

  it("says how to install, sign in, or switch away from an API login", () => {
    expect(() => assertSubscription({ installed: false, loggedIn: false })).toThrow(/npm install -g/);
    expect(() => assertSubscription({ installed: true, loggedIn: false })).toThrow(/claude auth login/);
    expect(() => assertSubscription({ installed: true, loggedIn: true, authMethod: "console" })).toThrow(
      /"console", not a Claude subscription.*billed to the API/,
    );
  });
});
