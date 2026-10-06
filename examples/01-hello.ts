/**
 * The smallest use: one question, one answer, on your Claude subscription.
 *
 *   npx tsx examples/01-hello.ts
 *
 * In your own project, import from "claude-cli-evals" instead of "../src/index.js".
 */
import { createClaude } from "../src/index.js";

const claude = createClaude({ model: "haiku" });

const answer = await claude.text("In two sentences: why do restaurants overbook on Friday nights?", {
  system: "You are a concise restaurant-industry analyst.",
});
console.log(answer);

const stats = claude.stats();
console.log(`\n${stats.calls} call, ${stats.avgMs} ms, $${stats.apiCostUsd.toFixed(4)} at API prices (not billed)`);
