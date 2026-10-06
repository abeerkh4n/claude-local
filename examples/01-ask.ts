/**
 * One question, one answer, on your Claude subscription.
 *
 *   npx tsx examples/01-ask.ts
 *
 * In your own project, import from "claude-local" instead of "../src/index.js".
 */
import { claude } from "../src/index.js";

const answer = await claude.ask("Give me three subject lines for an email announcing our new weekend brunch menu.", {
  model: "haiku",
  system: "You are a concise marketing writer.",
});
console.log(answer);

const stats = claude.stats();
console.log(`\n${stats.avgMs} ms · $${stats.apiCostUsd.toFixed(4)} at API prices (not billed)`);
