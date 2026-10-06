#!/usr/bin/env node
/**
 * Checks this machine end to end: CLI installed, signed in with a Claude
 * subscription, and one real call answered.
 *
 *   npx claude-local        (or npm run doctor inside this repo)
 */
import { runOnce } from "./process.js";
import { claudeStatus, isSubscription } from "./status.js";

function ok(line: string) {
  console.log(`✓ ${line}`);
}

function fail(line: string): never {
  console.error(`✗ ${line}`);
  process.exit(1);
}

async function main() {
  const status = claudeStatus();
  if (!status.installed) fail("Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code");
  ok(`Claude Code CLI ${status.version ?? ""}`.trim());

  if (!status.loggedIn) fail("Not signed in. Run `claude auth login` and sign in with your Claude account.");
  if (!isSubscription(status)) {
    fail(`Signed in with "${status.authMethod}", not a Claude subscription, so calls would be billed to the API.`);
  }
  ok(`Signed in with a Claude subscription${status.subscriptionType ? ` (${status.subscriptionType})` : ""}`);

  if (process.env.ANTHROPIC_API_KEY) {
    console.log("· ANTHROPIC_API_KEY is set in this shell. It is removed from every call, so it is never billed.");
  }

  const result = await runOnce("Reply with the single word OK.", { model: "haiku" });
  const seconds = (result.durationMs / 1000).toFixed(1);
  ok(`Test call: "${result.text.trim()}" from ${result.model} in ${seconds} s ($${result.apiCostUsd.toFixed(4)} at API prices, not billed)`);

  const limit = result.rateLimit;
  if (limit) {
    const resets = limit.resetsAt ? `, resets ${limit.resetsAt.toLocaleString()}` : "";
    ok(`Usage window (${limit.window ?? "current"}): ${limit.status}${resets}`);
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
