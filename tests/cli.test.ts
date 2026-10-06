import { describe, expect, it } from "vitest";
import { cliArgs, cliEnv } from "../src/cli.js";

describe("cliEnv", () => {
  it("drops API keys, other providers and the nested-session guard, keeps the rest, turns off side calls", () => {
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
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  });
});

describe("cliArgs", () => {
  it("a stream-json session: our system prompt, no tools, nothing saved, no settings or MCP", () => {
    expect(cliArgs({ model: "haiku", system: "SYS" })).toEqual([
      "-p", "--model", "haiku", "--system-prompt", "SYS", "--tools", "",
      "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "",
    ]);
  });

  it("always sends a system prompt and a model, so Claude Code's own prompt is never used", () => {
    const args = cliArgs({});
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("You are a helpful assistant.");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  });

  it("adds text streaming, the JSON schema and effort when asked", () => {
    const args = cliArgs({ partial: true, jsonSchema: { type: "object" }, effort: "medium" });
    expect(args.slice(-5)).toEqual(["--include-partial-messages", "--json-schema", '{"type":"object"}', "--effort", "medium"]);
  });
});
