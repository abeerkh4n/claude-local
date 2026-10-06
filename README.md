# claude-local

Use your **Claude subscription** from Node.js and TypeScript on your own machine, with no API key or API bill. You can ask questions, stream replies, get JSON back, send PDFs and images, and hold multi-turn chats.

It works through the Claude Code CLI you're already signed in to, so every call counts against your Pro, Max, Team or Enterprise plan instead of API credit.

```ts
import { claude } from "claude-local";

const answer = await claude.ask("Summarise this supplier email in two lines: ...");
```

> **Your machine, your login, your work.** It's for scripts and tools you run yourself. Don't run it on servers or in CI, don't share a login between people, and don't put it behind an API or app that other people use; those need an API key. If you're unsure, read Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and [Usage Policy](https://www.anthropic.com/legal/aup).

## Setup (5 minutes)

**1. Check you have Node 20.19 or newer.**

```bash
node --version
```

**2. Install Claude Code.** Skip this if `claude --version` already works.

```bash
npm install -g @anthropic-ai/claude-code
```

**3. Sign in with your Claude account.**

```bash
claude auth login
claude auth status      # look for  "loggedIn": true  and  "authMethod": "claude.ai"
```

If `authMethod` shows anything other than `claude.ai`, you're signed in with an API (Console) account and calls would be billed. Run `claude auth logout` and sign in again with your Claude account.

**4. Add the package to your project.** The repo is private, so your GitHub login needs access to it.

```bash
npm install github:abeerkh4n/claude-local
# or: pnpm add github:abeerkh4n/claude-local
```

It builds itself when it installs. It's an ES module, so use `import`. CommonJS code can `require()` it on Node 20.19 or newer.

**5. Check it works.**

```bash
npx claude-local
```

```
✓ Claude Code CLI 2.1.49
✓ Signed in with a Claude subscription (max)
✓ Test call: "OK" from claude-haiku-4-5-20251001 in 2.0 s ($0.0005 at API prices, not billed)
✓ Usage window (five_hour): allowed, resets 10/7/2026, 4:10:00 AM
```

You don't need to unset `ANTHROPIC_API_KEY`. The package removes it from every call it makes.

## What you can do

### Ask

```ts
import { claude } from "claude-local";

const text = await claude.ask("Three subject lines for our new brunch menu email", {
  model: "haiku",                           // or "sonnet" (default), "opus", or a full model id
  system: "You are a concise marketing writer.",
});
```

### Stream the reply as it's written

```ts
for await (const text of claude.stream("Draft a note to staff about the new roster")) {
  process.stdout.write(text);
}
```

### Get JSON back

Pass a JSON Schema and you get the parsed object back.

```ts
const booking = await claude.json<{ name: string; guests: number; date: string }>(
  `Extract the booking: "Hi, it's Morgan, table for 14 on Friday the 24th"`,
  {
    type: "object",
    properties: { name: { type: "string" }, guests: { type: "integer" }, date: { type: "string" } },
    required: ["name", "guests", "date"],
  },
);
```

### Send files

Files can be PDFs, images (png, jpg, gif, webp) or text files.

```ts
const summary = await claude.ask("Who is this from and what do we owe?", {
  files: ["./invoices/october.pdf"],
});
// Bytes you already have work too: files: [{ data: buffer, mediaType: "image/png" }]
```

### Chat

```ts
const chat = claude.chat({ system: "You are my writing assistant." });
await chat.send("Draft a LinkedIn post about our second location opening.");
await chat.send("Shorter, and less salesy.");        // it remembers the draft
for await (const t of chat.stream("Now a version for Instagram")) process.stdout.write(t);
await chat.close();
```

A chat stays in one Claude process. Claude sees the real conversation, and each reply after the first starts in about a second.

### Lots of items at once

```ts
import { createClaude } from "claude-local";

const claude = createClaude({ model: "haiku", concurrency: 6 });
const tags = await Promise.all(reviews.map((r) => claude.json(`Tag this review: ${r}`, schema)));
console.log(claude.stats()); // { calls, failures, retries, apiCostUsd, avgMs, rateLimit }
```

`apiCostUsd` is what the calls *would* have cost on the API. You aren't charged for it; it shows what you saved. The calls use up your plan's usage limit instead. `rateLimit` shows the state of that limit and when it resets.

## Examples

Clone the repo, run `npm install`, then:

| Run | Shows |
| --- | --- |
| `npx tsx examples/01-ask.ts` | One question and its stats |
| `npx tsx examples/02-stream.ts` | An email draft printed as it's written |
| `npx tsx examples/03-extract-json.ts` | A messy enquiry email turned into typed JSON |
| `npx tsx examples/04-files.ts [file]` | A PDF summarised and extracted. Uses the sample invoice, or your own file. |
| `npx tsx examples/05-chat.ts` | A chat in your terminal |
| `npx tsx examples/06-batch.ts` | Six reviews tagged at once, each with a suggested owner reply |

## API

| | |
| --- | --- |
| `claude` | A ready client with default settings. Nothing starts until the first call. |
| `createClaude(options)` | A client with your own defaults: `model`, `system`, `effort`, `concurrency` (default 4), `retries` (default 1, only after a timeout or crash), `timeoutMs` (default 5 min). |
| `client.ask(prompt, options)` | The reply text. `options`: `model`, `system`, `effort`, `files`, `jsonSchema`, `timeoutMs`, `signal`, `onText`. |
| `client.json(prompt, schema, options)` | The reply parsed against a JSON Schema. |
| `client.stream(prompt, options)` | Iterate for the text as it's written; `await stream.result` for the whole reply. |
| `client.run(prompt, options)` | The full result: `{ text, data, apiCostUsd, durationMs, model, usage, rateLimit }`. |
| `client.chat(options)` | A conversation with `send`, `stream`, `run`, `turns` and `close`. |
| `client.stats()` | Running totals for this client. |
| `claudeStatus()` / `assertSubscription()` | Whether the CLI is installed and signed in with a subscription. |

Every call is independent unless you use `chat()`. Before its first call, a client checks once that the CLI is signed in with a subscription, and refuses to run otherwise. Pass `requireSubscription: false` to skip this check.

Errors are `ClaudeCliError`. Check `err.kind` to see what went wrong:

| `err.kind` | Meaning |
| --- | --- |
| `not_installed` | The `claude` command wasn't found. |
| `auth` | Not signed in, or signed in without a subscription. |
| `usage_limit` | You've hit your plan's limit. `stats().rateLimit.resetsAt` says when it resets. |
| `timeout` | The call took longer than `timeoutMs`. |
| `aborted` | The `signal` you passed was aborted. |
| `cli_error` | The CLI reported an error, for example an unknown model. |
| `exit` | The CLI process exited unexpectedly. |
| `parse` | You asked for JSON and didn't get it. |
| `closed` | You sent a message to a chat that was already closed. |

**Models.** Aliases like `haiku`, `sonnet` and `opus` point to whatever your installed Claude Code version maps them to. For example, on 2.1.49 `opus` is Opus 4.6. Pass a full id such as `claude-opus-5` to pin a model. Newer models need a newer CLI, so run `claude update`.

## Evals add-on

There are also helpers for testing your own bots and prompts: an LLM judge and a simulated user.

```ts
import { judge, simulateConversation } from "claude-local/evals";

const verdict = await judge({
  model: "claude-opus-5",
  effort: "medium",
  context: "Open Tuesday to Sunday. Closed Mondays.",
  input: "Guest: Can I book for Monday at 7?",
  output: botReply,
  criteria: ["Does not offer or confirm a Monday booking", "Suggests a day the restaurant is open"],
});
// { passed, score, criteria: [{ criterion, met, reason }], summary, apiCostUsd }

const sim = await simulateConversation({
  persona: "You want a table for 4 on Friday at 8pm. You're polite but brief.",
  respond: async (message, turns) => callMyBot(turns), // the system you're testing
});
```

The eval examples are in [`examples/evals/`](examples/evals):

| Run | Shows |
| --- | --- |
| `npx tsx examples/evals/judge.ts` | A judge grading three replies |
| `npx tsx examples/evals/chatbot-api.ts` | A simulated guest testing a chatbot over HTTP, graded at the end |
| `npm run test:live` | The judge inside a Vitest suite |

The chatbot example can pass or fail from one run to the next. The demo bot's prompt never says not to book big groups, so it sometimes confirms the booking for 12 anyway, and the judge catches that when it happens.

## Limits

- **Text, files and JSON only.** You can't give the model your own tools (function calling). If you need tool use, use the API.
- **Fewer controls.** There's no temperature, max-tokens or prompt-caching setting. `effort` is available.
- **About 2–3 seconds of startup per call.** Chats only pay it once. Run independent calls side by side to save time.
- **Shared usage limits.** Calls count against the same limit as your Claude and Claude Code use, so a large batch can use up the current 5-hour window.

## Troubleshooting

- **`Claude Code CLI not found`.** Install it (step 2), or pass `bin: "/path/to/claude"`.
- **`not a Claude subscription`.** Run `claude auth logout`, then `claude auth login` with your Claude account.
- **`Claude Code x.y.z does not support this model`.** Your CLI is older than the model. Run `claude update`.
- **Works in a terminal but not from your app.** The app's `PATH` must include the folder where `claude` is installed.
- **`require() of ES Module`.** Use `import` (ESM), or Node 20.19+, which can `require()` it.

## Development

```bash
npm install
npm test          # unit tests; these never start the real CLI
npm run typecheck
npm run test:live # live test on your subscription
npm run doctor
```

How it works, flag by flag: [docs/how-it-works.md](docs/how-it-works.md).
