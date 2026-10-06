# How it works

Claude Code has a headless mode: `claude -p` runs without the interactive screen and uses whatever login the CLI already has. On a machine signed in with a Claude subscription, its calls count against that subscription.

Used as-is, `claude -p` behaves like a coding agent, not a plain model call. It loads Claude Code's own system prompt, its tools, your settings, your MCP servers and the CLAUDE.md files in the folder it runs from. This package turns all of that off, then talks to the CLI in its streaming JSON mode.

## The command

```
claude -p
  --model <alias or id>
  --system-prompt <your system prompt>
  --tools ""
  --input-format stream-json
  --output-format stream-json
  --verbose
  --no-session-persistence
  --strict-mcp-config
  --setting-sources ""
  [--include-partial-messages]     only when you stream
  [--json-schema <schema>]         only for JSON replies
  [--effort low|medium|high]
```

| Flag | Why |
| --- | --- |
| `--system-prompt` | Replaces Claude Code's built-in prompt with yours. The package always sends one (default `You are a helpful assistant.`), so the coding prompt is never used. |
| `--tools ""` | Turns off every built-in tool: no file reads, no shell, no web. |
| `--strict-mcp-config` | Loads no MCP servers. |
| `--setting-sources ""` | Ignores user, project and local `settings.json`, including hooks and permissions. |
| `--no-session-persistence` | Saves nothing to `~/.claude`, so these calls don't clutter your Claude Code history. |
| `--input-format stream-json` | Takes messages as JSON lines on stdin. This allows any length, images and PDFs, and several turns in one process. |
| `--output-format stream-json --verbose` | Prints events as JSON lines: the reply, usage, cost and the plan's usage window. |
| `--include-partial-messages` | Adds the reply text as it's written, for `stream()` and `onText`. |
| `--json-schema` | Makes the model answer in JSON that matches the schema. The answer comes back as `structured_output`. |

## Messages in

Each user turn is one line on stdin:

```json
{"type":"user","message":{"role":"user","content":"Summarise this..."}}
```

With files, `content` is a list of blocks in the Messages API format. Images become `image` blocks, PDFs become `document` blocks (both base64), and any other file is read as text and wrapped in `<file name="...">`. The prompt goes last.

## Events out

The package reads these lines and ignores the rest:

| Event | Used for |
| --- | --- |
| `stream_event` with a `text_delta` | Text as it's written, passed to `onText` and `stream()`. Thinking deltas are skipped. |
| `rate_limit_event` | `rateLimit`: the window (e.g. `five_hour`), its status (`allowed`, `allowed_warning`, `rejected`) and when it resets. |
| `result` | The end of the turn: the reply text, `structured_output`, token usage, the model, and `total_cost_usd`. |

`total_cost_usd` is the API list price of the calls so far **in that process**, a running total. Each turn's cost is the difference from the previous turn. On a subscription none of it is charged.

A `result` with `is_error: true` rejects with a `ClaudeCliError`. This can happen even when `subtype` says `"success"`, for example when the model isn't supported by your CLI version. If the latest `rate_limit_event` said `rejected`, the error kind is `usage_limit`; otherwise it's `cli_error`.

## One call vs a chat

- **`ask` / `json` / `stream` / `run`** start a fresh process, send one message, read the result, then close stdin so the CLI exits. Calls never see each other.
- **`chat()`** keeps one process open and sends each message after the previous reply has finished. The CLI merges a message sent mid-reply into the same turn, so the package queues them. The model sees the real conversation history, and only the first turn pays the 2–3 second startup. An idle chat doesn't keep Node running: its pipes are unreferenced between turns, and the CLI exits when stdin closes.

## The working folder

Claude Code reads `CLAUDE.md` and project memory from the folder it runs in. Every process runs from one **empty temp folder**, created once and removed when Node exits, so no project's instructions leak into the prompt. A short call measured about 150 input tokens, which is only what we sent.

## The environment

These variables are removed from the CLI's environment (your own process keeps them):

| Variable | Why |
| --- | --- |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | When either is set, the CLI bills that key instead of your subscription. |
| `ANTHROPIC_BASE_URL` | Would send calls to a proxy or gateway. |
| `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` | Would route calls to a cloud provider account. |
| `CLAUDECODE` | Set inside a Claude Code session. A nested `claude` refuses to start while it's present. |

## The login check

Before its first call, a client runs `claude auth status` once, with the same cleaned environment. It refuses to go on unless the result shows `"loggedIn": true` and `"authMethod": "claude.ai"`. Any other method is an API (Console) login, which would be billed.
