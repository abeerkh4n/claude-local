# How it works

Claude Code has a headless mode: `claude -p` takes one prompt, prints one answer and exits. It uses whatever login the CLI already has, so on a machine signed in with a Claude subscription the call counts against that subscription.

On its own, `claude -p` is a coding agent rather than a plain model call: it loads Claude Code's own system prompt, its tools, your settings, MCP servers and the CLAUDE.md files in the folder it runs from. This package turns all of that off so the call behaves like one API request.

## The command

```
claude -p
  --model <alias or id>
  --system-prompt <your system prompt>
  --tools ""
  --output-format json
  --no-session-persistence
  --strict-mcp-config
  --setting-sources ""
  [--json-schema <schema>]
  [--effort low|medium|high]
```

The prompt goes in on **stdin**, so it can be any length and never shows up in the process list.

| Flag | Why |
| --- | --- |
| `--system-prompt` | Replaces Claude Code's built-in prompt with yours. The package always sends one (default `You are a helpful assistant.`) so the coding prompt is never used. |
| `--tools ""` | Turns off every built-in tool: no file reads, no shell, no web. |
| `--strict-mcp-config` | Loads no MCP servers (none are passed via `--mcp-config`). |
| `--setting-sources ""` | Ignores user, project and local `settings.json`, including hooks and permissions. |
| `--no-session-persistence` | Saves nothing to `~/.claude`, so evals don't clutter your session history. |
| `--output-format json` | Prints one JSON result with the text, token usage and `total_cost_usd`. |
| `--json-schema` | Makes the model answer in JSON that matches the schema; it comes back as `structured_output`. |

## The working folder

Claude Code reads `CLAUDE.md` and project memory from the folder it runs in. Every call runs from one **empty temp folder**, created once per process and removed on exit, so none of your project's instructions leak into the prompt. A short call measured 144 input tokens, which is only the prompt we sent.

## The environment

Before each call these variables are removed from the child's environment:

| Variable | Why |
| --- | --- |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | If either is set, the CLI bills that key instead of your subscription. |
| `ANTHROPIC_BASE_URL` | Would send the call to a proxy or gateway. |
| `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` | Would route the call to a cloud provider account. |
| `CLAUDECODE` | Set inside a Claude Code session. A nested `claude` refuses to start while it's present, so without removing it, evals launched from Claude Code would fail. |

Your own process keeps them. Only the CLI child loses them, so the system you're testing can keep using its API key in the same process.

## The login check

`createClaude()` runs `claude auth status` once before its first call (with the same cleaned environment) and refuses to continue unless it reports `"loggedIn": true` and `"authMethod": "claude.ai"`. Any other method is an API/Console login, which would be billed. Pass `requireSubscription: false` to skip the check.

## The result

The CLI prints a single JSON object:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "the reply text",
  "structured_output": { "only": "with --json-schema" },
  "total_cost_usd": 0.0013,
  "usage": { "input_tokens": 144, "output_tokens": 61, "...": "..." },
  "modelUsage": { "claude-haiku-4-5-20251001": { "...": "..." } }
}
```

- `result` becomes `text`.
- `structured_output` becomes `data`.
- `total_cost_usd` becomes `apiCostUsd`. This is the API list price of the call. On a subscription it isn't charged; it shows what you saved.
- The first key of `modelUsage` becomes `model`.

If `is_error` is true, for example when you hit a usage limit, the call rejects with a `ClaudeCliError` of kind `cli_error`, carrying the CLI's own message. If a warning line is printed before the JSON, the parser takes the last result line.

## Conversations

The CLI takes one prompt, not a list of messages. For multi-turn work (the user simulator, a judge reading a transcript) the history is written out as labelled lines (`YOU: ...` / `ASSISTANT: ...`) inside that single prompt. That works well for simulating and grading. It is not the same as the Messages API for the system you're testing, which is why the system under test should stay on its normal API.
