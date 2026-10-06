import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCliError } from "../src/cli.js";
import { answeringModel, CliProcess, runOnce } from "../src/process.js";
import { fakeCli } from "./helpers.js";

const kindOf = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as ClaudeCliError).kind;

describe("runOnce", () => {
  it("writes one user message to stdin, from an empty folder, without the API key, then ends stdin", async () => {
    const { impl, spawns } = fakeCli(["Two laksas please."]);
    const result = await runOnce("P", { system: "S", env: { ANTHROPIC_API_KEY: "k", CLAUDECODE: "1", PATH: "/bin" }, spawnImpl: impl });
    expect(result).toMatchObject({
      text: "Two laksas please.",
      model: "claude-haiku-4-5-20251001",
      apiCostUsd: 0.01,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const s = spawns[0]!;
    expect(s.bin).toBe("claude");
    expect(s.messages).toEqual([{ role: "user", content: "P" }]);
    expect(s.options.env).toEqual({ PATH: "/bin", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    expect(readdirSync(s.options.cwd)).toEqual([]);
    expect(s.stdinEnded).toBe(true);
    expect(s.args).not.toContain("--include-partial-messages");
  });

  it("streams reply text to onText and never thinking", async () => {
    const { impl, spawns } = fakeCli([{ thinking: ["hmm"], deltas: ["Hel", "lo"] }]);
    const seen: string[] = [];
    const result = await runOnce("P", { spawnImpl: impl, onText: (t) => seen.push(t) });
    expect(seen).toEqual(["Hel", "lo"]);
    expect(result.text).toBe("Hello");
    expect(spawns[0]!.args).toContain("--include-partial-messages");
  });

  it("skips non-JSON lines and joins a result split across chunks", async () => {
    const { impl } = fakeCli([{ text: "ok", noisy: true }]);
    expect((await runOnce("P", { spawnImpl: impl })).text).toBe("ok");
  });

  it("returns structured output as data, or parses the text, for a jsonSchema call", async () => {
    const structured = fakeCli([{ text: "", data: { n: 7 } }]);
    expect((await runOnce("P", { jsonSchema: {}, spawnImpl: structured.impl })).data).toEqual({ n: 7 });
    const inText = fakeCli(['{"n":8}']);
    expect((await runOnce("P", { jsonSchema: {}, spawnImpl: inText.impl })).data).toEqual({ n: 8 });
    const notJson = fakeCli(["eight"]);
    await expect(runOnce("P", { jsonSchema: {}, spawnImpl: notJson.impl })).rejects.toThrow(/Asked for JSON but got: eight/);
  });

  it("reports the usage window", async () => {
    const { impl } = fakeCli([{ text: "ok", rateLimit: "allowed" }]);
    const { rateLimit } = await runOnce("P", { spawnImpl: impl });
    expect(rateLimit).toEqual({ status: "allowed", resetsAt: new Date(1791328200 * 1000), window: "five_hour" });
  });

  it("an error result is a cli_error; after a rejected usage window it is a usage_limit", async () => {
    const plain = fakeCli([{ error: "Claude Code 2.1.49 does not support this model" }]);
    const err = (await runOnce("P", { spawnImpl: plain.impl }).catch((e) => e)) as ClaudeCliError;
    expect(err.kind).toBe("cli_error");
    expect(err.message).toMatch(/does not support this model/);
    const limited = fakeCli([{ error: "limit reached", rateLimit: "rejected" }]);
    expect(await kindOf(runOnce("P", { spawnImpl: limited.impl }))).toBe("usage_limit");
  });

  it("a crash rejects with the exit code and stderr", async () => {
    const { impl } = fakeCli([{ crash: true }], { stderr: "error: unknown option '--bogus'" });
    const err = (await runOnce("P", { spawnImpl: impl }).catch((e) => e)) as ClaudeCliError;
    expect(err.kind).toBe("exit");
    expect(err.message).toMatch(/code 1.*unknown option/);
  });

  it("says how to install the CLI when it is missing", async () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const { impl } = fakeCli([{ hang: true }], { spawnError: enoent });
    const err = (await runOnce("P", { spawnImpl: impl }).catch((e) => e)) as ClaudeCliError;
    expect(err.kind).toBe("not_installed");
    expect(err.message).toMatch(/npm install -g @anthropic-ai\/claude-code/);
  });

  it("kills a call that hangs, or one whose signal aborts", async () => {
    const slow = fakeCli([{ hang: true }]);
    expect(await kindOf(runOnce("P", { spawnImpl: slow.impl, timeoutMs: 20 }))).toBe("timeout");
    expect(slow.spawns[0]!.killed).toBe(true);

    const aborted = fakeCli([{ hang: true }]);
    const controller = new AbortController();
    const pending = runOnce("P", { spawnImpl: aborted.impl, signal: controller.signal });
    controller.abort();
    expect(await kindOf(pending)).toBe("aborted");
    expect(aborted.spawns[0]!.killed).toBe(true);
  });

  it("does not start when the signal is already aborted", async () => {
    const { impl, spawns } = fakeCli(["ok"]);
    expect(await kindOf(runOnce("P", { spawnImpl: impl, signal: AbortSignal.abort() }))).toBe("aborted");
    expect(spawns).toHaveLength(0);
  });
});

describe("answeringModel", () => {
  const usage = { "claude-haiku-4-5-20251001": {}, "claude-opus-5-5": {} };
  it("picks the model that was asked for, not a side call listed first", () => {
    expect(answeringModel(usage, "opus")).toBe("claude-opus-5-5");
    expect(answeringModel(usage, "claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(answeringModel(usage, "haiku")).toBe("claude-haiku-4-5-20251001");
  });
  it("falls back to the last model listed", () => {
    expect(answeringModel(usage, "sonnet")).toBe("claude-opus-5-5");
    expect(answeringModel(undefined, "opus")).toBeUndefined();
  });
});

describe("CliProcess (a conversation)", () => {
  it("keeps every turn in one process and reports each turn's own cost", async () => {
    const { impl, spawns } = fakeCli([{ text: "OK.", cost: 0.25 }, { text: "Zara.", cost: 0.5 }]);
    const proc = new CliProcess({ spawnImpl: impl });
    const first = await proc.send("My name is Zara.");
    const second = await proc.send("What is my name?");
    await proc.close();
    expect([first.text, second.text]).toEqual(["OK.", "Zara."]);
    expect([first.apiCostUsd, second.apiCostUsd]).toEqual([0.25, 0.5]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.messages.map((m) => m.content)).toEqual(["My name is Zara.", "What is my name?"]);
  });

  it("refuses a second message while a reply is being written", async () => {
    const { impl } = fakeCli([{ hang: true }]);
    const proc = new CliProcess({ spawnImpl: impl });
    const first = proc.send("one", { timeoutMs: 50 });
    await expect(proc.send("two")).rejects.toThrow(/still being written/);
    await first.catch(() => {});
  });

  it("after close, or after the process died, a send says why", async () => {
    const { impl } = fakeCli(["ok"]);
    const proc = new CliProcess({ spawnImpl: impl });
    await proc.send("hi");
    await proc.close();
    expect(await kindOf(proc.send("again"))).toBe("closed");

    const crashed = fakeCli([{ crash: true }]);
    const dead = new CliProcess({ spawnImpl: crashed.impl });
    expect(await kindOf(dead.send("hi"))).toBe("exit");
    expect(await kindOf(dead.send("again"))).toBe("exit");
  });
});
