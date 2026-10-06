import { describe, expect, it } from "vitest";
import { ClaudeCliError } from "../src/cli.js";
import { createClaude, createLimiter } from "../src/client.js";
import type { ClaudeStatus } from "../src/status.js";
import { fakeRun } from "./helpers.js";

const SIGNED_IN: ClaudeStatus = { installed: true, loggedIn: true, authMethod: "claude.ai" };

describe("createClaude", () => {
  it("checks the login once, before the first call", async () => {
    let checks = 0;
    const { impl } = fakeRun([{ text: "hi" }]);
    const claude = createClaude({ runImpl: impl, statusImpl: () => (checks++, SIGNED_IN) });
    await Promise.all([claude.text("a"), claude.text("b"), claude.text("c")]);
    expect(checks).toBe(1);
  });

  it("refuses to call when the CLI is signed in with an API login", async () => {
    const { impl, calls } = fakeRun([{ text: "hi" }]);
    const claude = createClaude({
      runImpl: impl,
      statusImpl: () => ({ installed: true, loggedIn: true, authMethod: "console" }),
    });
    await expect(claude.text("a")).rejects.toThrow(/not a Claude subscription/);
    expect(calls).toHaveLength(0);
  });

  it("applies client defaults; an undefined call option keeps the default", async () => {
    const { impl, calls } = fakeRun([{ text: "hi" }]);
    const claude = createClaude({ runImpl: impl, requireSubscription: false, model: "haiku", system: "S" });
    await claude.run({ prompt: "p", model: undefined });
    await claude.run({ prompt: "p", model: "opus" });
    expect(calls[0]).toMatchObject({ prompt: "p", model: "haiku", system: "S" });
    expect(calls[1]).toMatchObject({ model: "opus", system: "S" });
  });

  it("json() sends the schema and returns the parsed data", async () => {
    const { impl, calls } = fakeRun([{ data: { intent: "book" } }]);
    const claude = createClaude({ runImpl: impl, requireSubscription: false });
    expect(await claude.json("p", { type: "object" })).toEqual({ intent: "book" });
    expect(calls[0]!.jsonSchema).toEqual({ type: "object" });
  });

  it("retries a timeout once, then succeeds", async () => {
    const { impl, calls } = fakeRun([new ClaudeCliError("timeout", "slow"), { text: "ok" }]);
    const claude = createClaude({ runImpl: impl, requireSubscription: false });
    expect(await claude.text("p")).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(claude.stats()).toMatchObject({ calls: 1, retries: 1, failures: 0 });
  });

  it("does not retry a CLI error such as a usage limit", async () => {
    const { impl, calls } = fakeRun([new ClaudeCliError("cli_error", "usage limit reached"), { text: "ok" }]);
    const claude = createClaude({ runImpl: impl, requireSubscription: false, retries: 3 });
    await expect(claude.text("p")).rejects.toThrow(/usage limit/);
    expect(calls).toHaveLength(1);
    expect(claude.stats().failures).toBe(1);
  });

  it("adds up calls, would-be API cost and average time", async () => {
    const { impl } = fakeRun([{ text: "a", apiCostUsd: 0.25, durationMs: 100 }, { text: "b", apiCostUsd: 0.5, durationMs: 300 }]);
    const claude = createClaude({ runImpl: impl, requireSubscription: false });
    await claude.text("1");
    await claude.text("2");
    expect(claude.stats()).toEqual({ calls: 2, failures: 0, retries: 0, apiCostUsd: 0.75, avgMs: 200 });
  });
});

describe("createLimiter", () => {
  it("never runs more than the limit at once, and runs everything", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = async (n: number) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return n;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => limit(() => task(n))));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("keeps going after a task fails", async () => {
    const limit = createLimiter(1);
    const failed = limit(() => Promise.reject(new Error("boom")));
    const next = limit(() => Promise.resolve("ok"));
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});
