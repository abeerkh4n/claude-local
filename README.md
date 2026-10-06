# claude-cli-evals

Run the LLM calls in your evals and tests through **your own signed-in Claude Code CLI**, so they count against your Claude subscription instead of an API key's credit.

Good for the parts of testing that are plain text in, text out:

- **LLM-as-judge**: grading replies, summaries or whole transcripts against criteria
- **Simulated users**: a model playing a customer against your chatbot or API
- **Prompt regression checks**: a prompt run over a table of cases before you ship an edit
- One-off jobs on your machine: summarising logs, generating test data, structured extraction

At Forktime this moved the simulated caller and the judge in our voice-agent evals off the API key, which cut about a third of a ~$300/month eval bill.

> **Use it on your own machine, signed in as yourself, for your own development and testing.** Don't run it on servers or in CI, don't share one login between people, and don't put it behind an API for others to call. Those uses need an API key. Read Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and [Usage Policy](https://www.anthropic.com/legal/aup) if you're unsure.

## Setup (5 minutes)

**1. Node 20.19 or newer.**

```bash
node --version
```

**2. Install Claude Code** (skip if `claude --version` already works):

```bash
npm install -g @anthropic-ai/claude-code
```

**3. Sign in with your Claude account** (Pro, Max, Team or Enterprise):

```bash
claude auth login
claude auth status      # should show  "loggedIn": true  and  "authMethod": "claude.ai"
```

If `authMethod` is anything other than `claude.ai`, you are signed in with an API (Console) account and calls would be billed to it. Run `claude auth logout` and sign in again with your Claude account.

**4. Add the package to your project.** The repo is private, so your GitHub login needs access to it:

```bash
npm install -D github:abeerkh4n/claude-cli-evals
# or: pnpm add -D github:abeerkh4n/claude-cli-evals
```

It builds itself on install.

**5. Check everything works:**

```bash
npx claude-cli-evals
```

```
✓ Claude Code CLI 2.1.49
✓ Signed in with a Claude subscription (max)
✓ Test call: "OK" from claude-haiku-4-5-20251001 in 3.1 s ($0.0005 at API prices, not billed)
```

You don't need to unset `ANTHROPIC_API_KEY`: the package removes it from every call (see [How it works](docs/how-it-works.md)).

## Quick start

```ts
import { createClaude } from "claude-cli-evals";

const claude = createClaude({ model: "haiku" });

const answer = await claude.text("Summarise this complaint in one line: ...", {
  system: "You are a support lead.",
});

const { intent } = await claude.json<{ intent: string }>("can we move our 7pm to 8?", {
  type: "object",
  properties: { intent: { type: "string", enum: ["book", "change", "cancel"] } },
  required: ["intent"],
});

console.log(claude.stats());
// { calls: 2, failures: 0, retries: 0, apiCostUsd: 0.0031, avgMs: 4210 }
```

`apiCostUsd` is what the calls *would* have cost on the API. You aren't charged it; it uses up your plan's usage limit instead.

## Examples

Run any of these from a clone of this repo (`npm install` first):

| Example | What it shows |
| --- | --- |
| [`01-hello.ts`](examples/01-hello.ts) | One call and its stats |
| [`02-judge.ts`](examples/02-judge.ts) | An Opus judge grading three replies to an allergy question against menu facts |
| [`03-chatbot-api.ts`](examples/03-chatbot-api.ts) | A simulated guest talks to a chatbot **over HTTP**, then a judge grades the transcript |
| [`04-prompt-regression.ts`](examples/04-prompt-regression.ts) | A routing prompt run over six cases at once; exits 1 if any answer is wrong |
| [`05-in-a-test.test.ts`](examples/05-in-a-test.test.ts) | The judge inside a Vitest suite, skipped unless `CLAUDE_CLI_LIVE=1` |

```bash
npx tsx examples/02-judge.ts
npm run test:live
```

`03-chatbot-api.ts` usually **fails on purpose**. The demo bot's prompt never says not to book groups larger than 8, so the bot takes a phone number for the manager and then confirms the booking for 12 anyway. The judge catches that. This is what a useful failure looks like. To test your own service, replace the demo server with your real URL. Only the simulated guest and the judge use your subscription; your bot keeps its normal model and API key.

### Judge

```ts
import { judge } from "claude-cli-evals";

const verdict = await judge({
  context: "Open Tuesday to Sunday, 5pm to 10pm. Closed Mondays.",
  input: "Guest: Can I book for Monday at 7?",
  output: botReply,
  criteria: ["Does not offer or confirm a Monday booking", "Suggests a day the restaurant is open"],
});
// { passed: true, score: 9, criteria: [{ criterion, met, reason }, ...], summary, apiCostUsd }
```

It passes only if every criterion is met **and** the score is at least `passMark` (default 7). It uses `opus` by default. To pin the judge so scores stay comparable between runs, pass a full model id and an effort:

```ts
await judge({ model: "claude-opus-5", effort: "medium", criteria, output });
```

Grading on your subscription costs no API money, so it is worth using the strongest judge. Opus does use your usage limit faster than Haiku.

### Simulated user

```ts
import { simulateConversation } from "claude-cli-evals";

const sim = await simulateConversation({
  persona: "You want a table for 4 on Friday at 8pm. Your name is Sam. You're polite but brief.",
  greeting: "Hi, how can I help?",
  respond: async (message, turns) => callMyBot(turns), // your system under test
  maxTurns: 8,
});
// sim.turns: [{ role: "assistant" | "user", content }], sim.finished: the user said it was done
```

The simulated user runs on `haiku` by default and ends the conversation itself when its goal is done.

## API

| Function | Purpose |
| --- | --- |
| `createClaude(options)` | A client with a one-time login check, a concurrency limit (default 4), one retry after a timeout or crash, and running totals in `stats()`. Use this for evals. |
| `client.run({ prompt, system, model, jsonSchema, effort, timeoutMs, signal })` | One call. Returns `{ text, data, apiCostUsd, durationMs, model, usage }`. |
| `client.text(prompt, options)` / `client.json(prompt, schema, options)` | Shortcuts for text replies and schema-checked JSON replies. |
| `judge(options)` | LLM-as-judge with per-criterion verdicts. |
| `simulateConversation(options)` | A simulated user against your `respond` function. |
| `formatTranscript(turns, labels)` | Turns a message list into the labelled transcript the CLI takes. |
| `runClaude(options)` | The low-level call, with no login check, limit or retry. |
| `claudeStatus()` / `assertSubscription()` | Whether the CLI is installed and signed in with a subscription. |

Errors are `ClaudeCliError`, and `err.kind` is one of the following:

| `err.kind` | Meaning |
| --- | --- |
| `not_installed` | The `claude` command was not found. |
| `auth` | Not signed in, or signed in without a subscription. |
| `timeout` | The call took longer than `timeoutMs`. |
| `aborted` | The `signal` you passed was aborted. |
| `cli_error` | The CLI itself reported an error, such as a usage limit. This kind is never retried. |
| `exit` | The CLI exited with an error code. |
| `parse` | The reply could not be read as expected. |

Models: use an alias (`haiku`, `sonnet`, `opus`) or a full id such as `claude-haiku-4-5`. An alias points to whatever model your installed Claude Code version maps it to; for example, `opus` on 2.1.49 is Opus 4.6. Pass a full id when you need the same model on every machine. Newer models need a newer CLI: run `claude update`.

## Limits

- **Text in, text out only.** You can't give the model your own tools. To test an agent that calls tools, run that agent on the API as usual, and use this package only for the user simulator and the judge around it.
- **Fewer controls.** There is no temperature, max-tokens or prompt-caching setting. `effort` is available.
- **Slower per call.** Each call starts a CLI process, which adds about 2–3 seconds. Typical times we saw: Haiku 3–8 s, Opus judge 8–15 s. Run calls side by side with `concurrency`.
- **Shared usage limits.** Calls count against the same limits as your normal Claude and Claude Code use. A long eval run can use up your usage window. When that happens, calls fail with a `cli_error` that names the limit.
- **One conversation is one prompt.** Message history is sent as a transcript inside the prompt, not as separate messages.

## Troubleshooting

- **`Claude Code CLI not found`.** Install it (step 2), or pass `bin: "/path/to/claude"`.
- **`not a Claude subscription`.** Run `claude auth logout`, then `claude auth login` with your Claude account.
- **`Claude Code x.y.z does not support this model`.** Your CLI is older than the model. Run `claude update` (or `npm install -g @anthropic-ai/claude-code@latest`).
- **Works in a terminal but not in your app.** Check that `PATH` in your app's environment includes the folder where `claude` is installed.
- **Unexpected replies.** The CLI runs from an empty temp folder with no settings, tools or MCP servers loaded. If you see project rules leaking in, open an issue with your CLI version.

## Development

```bash
npm install
npm test          # unit tests; never start the CLI
npm run typecheck
npm run test:live # the live example test, on your subscription
npm run doctor
```

More detail on why each flag is there: [docs/how-it-works.md](docs/how-it-works.md).
