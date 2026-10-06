import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCliError, cliArgs, cliEnv, parseResult, runClaude } from "../src/cli.js";
import { fakeSpawn, OK_RESULT } from "./helpers.js";

const OK = JSON.stringify(OK_RESULT);

describe("cliEnv", () => {
  it("drops API keys, other providers and the nested-session guard, keeps the rest", () => {
    const env = cliEnv({
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_BASE_URL: "u",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDECODE: "1",
      PATH: "/bin",
      HOME: "/h",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("cliArgs", () => {
  it("one headless turn: our system prompt, no tools, JSON out, nothing saved, no settings or MCP", () => {
    expect(cliArgs({ model: "haiku", system: "SYS" })).toEqual([
      "-p", "--model", "haiku", "--system-prompt", "SYS", "--tools", "",
      "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "",
    ]);
  });

  it("always sends a system prompt and a model, so Claude Code's own prompt is never used", () => {
    const args = cliArgs({});
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("You are a helpful assistant.");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  });

  it("adds the JSON schema and effort when given", () => {
    const args = cliArgs({ jsonSchema: { type: "object" }, effort: "low" });
    expect(args.slice(-4)).toEqual(["--json-schema", '{"type":"object"}', "--effort", "low"]);
  });
});

describe("parseResult", () => {
  it("returns the text, the would-be API cost, the model and token usage", () => {
    expect(parseResult(OK)).toEqual({
      text: "Two laksas please.",
      data: undefined,
      apiCostUsd: 0.0008,
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 174, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it("finds the result line after a warning", () => {
    expect(parseResult(`some warning\n${OK}\n`).text).toBe("Two laksas please.");
  });

  it("returns structured output as data", () => {
    const out = JSON.stringify({ ...OK_RESULT, result: "", structured_output: { score: 3 } });
    expect(parseResult(out).data).toEqual({ score: 3 });
  });

  it("throws a cli_error on an error result, with the CLI's message", () => {
    const bad = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "usage limit reached" });
    expect(() => parseResult(bad)).toThrow(/usage limit reached/);
    try {
      parseResult(bad);
    } catch (err) {
      expect((err as ClaudeCliError).kind).toBe("cli_error");
    }
  });

  it("treats is_error as a failure even when subtype says success (an unsupported model does this)", () => {
    const bad = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: 'API Error: 400 {"message":"Claude Code 2.1.49 does not support this model"}',
    });
    expect(() => parseResult(bad)).toThrow(/does not support this model/);
  });

  it("throws a parse error on empty or non-JSON output", () => {
    expect(() => parseResult("")).toThrow(/no result/);
    expect(() => parseResult("hello")).toThrow(/no result/);
    expect(() => parseResult('{"type":"assistant"}')).toThrow(/no result/);
  });
});

describe("runClaude", () => {
  it("sends the prompt on stdin, from an empty folder, without the API key", async () => {
    const { impl, calls } = fakeSpawn({ stdout: OK });
    const result = await runClaude({
      prompt: "P",
      system: "S",
      env: { ANTHROPIC_API_KEY: "k", CLAUDECODE: "1", PATH: "/bin" },
      spawnImpl: impl,
    });
    expect(result.text).toBe("Two laksas please.");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const call = calls[0]!;
    expect(call.bin).toBe("claude");
    expect(call.stdin).toBe("P");
    expect(call.options.env).toEqual({ PATH: "/bin" });
    expect(readdirSync(call.options.cwd)).toEqual([]);
  });

  it("returns parsed data for a jsonSchema call", async () => {
    const { impl } = fakeSpawn({ stdout: JSON.stringify({ ...OK_RESULT, result: "", structured_output: { ok: true } }) });
    const result = await runClaude({ prompt: "P", jsonSchema: { type: "object" }, spawnImpl: impl });
    expect(result.data).toEqual({ ok: true });
  });

  it("falls back to parsing the text when a jsonSchema call has no structured output", async () => {
    const { impl } = fakeSpawn({ stdout: JSON.stringify({ ...OK_RESULT, result: '{"ok":true}' }) });
    const result = await runClaude({ prompt: "P", jsonSchema: { type: "object" }, spawnImpl: impl });
    expect(result.data).toEqual({ ok: true });
  });

  it("rejects a jsonSchema call whose reply is not JSON", async () => {
    const { impl } = fakeSpawn({ stdout: OK });
    await expect(runClaude({ prompt: "P", jsonSchema: { type: "object" }, spawnImpl: impl })).rejects.toThrow(
      /Asked for JSON but got: Two laksas/,
    );
  });

  it("rejects with stderr and the exit code when the CLI fails", async () => {
    const { impl } = fakeSpawn({ stderr: "error: unknown option '--bogus'", code: 1 });
    const err = await runClaude({ prompt: "P", spawnImpl: impl }).catch((e: ClaudeCliError) => e);
    expect(err).toBeInstanceOf(ClaudeCliError);
    expect((err as ClaudeCliError).kind).toBe("exit");
    expect((err as ClaudeCliError).message).toMatch(/exit 1.*unknown option/);
  });

  it("says how to install the CLI when it is missing", async () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const { impl } = fakeSpawn({ error: enoent });
    const err = (await runClaude({ prompt: "P", spawnImpl: impl }).catch((e) => e)) as ClaudeCliError;
    expect(err.kind).toBe("not_installed");
    expect(err.message).toMatch(/npm install -g @anthropic-ai\/claude-code/);
  });

  it("kills a call that hangs", async () => {
    const { impl, calls } = fakeSpawn({ hang: true });
    const err = (await runClaude({ prompt: "P", spawnImpl: impl, timeoutMs: 20 }).catch((e) => e)) as ClaudeCliError;
    expect(err.kind).toBe("timeout");
    expect(calls[0]!.child.killed).toBe(true);
  });

  it("kills the call when the signal aborts", async () => {
    const { impl, calls } = fakeSpawn({ hang: true });
    const controller = new AbortController();
    const pending = runClaude({ prompt: "P", spawnImpl: impl, signal: controller.signal });
    controller.abort();
    const err = (await pending.catch((e) => e)) as ClaudeCliError;
    expect(err.kind).toBe("aborted");
    expect(calls[0]!.child.killed).toBe(true);
  });

  it("does not start when the signal is already aborted", async () => {
    const { impl, calls } = fakeSpawn({ stdout: OK });
    const err = (await runClaude({ prompt: "P", spawnImpl: impl, signal: AbortSignal.abort() }).catch((e) => e)) as ClaudeCliError;
    expect(err.kind).toBe("aborted");
    expect(calls).toHaveLength(0);
  });
});
