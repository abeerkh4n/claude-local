/**
 * Print the reply as it is written, like the Claude app does.
 *
 *   npx tsx examples/02-stream.ts
 */
import { claude } from "../src/index.js";

const stream = claude.stream(
  "Draft a short, warm email to our regular guests: we're closed Monday 19 October for a staff training day, and open as usual from Tuesday.",
  { model: "sonnet", system: "You write for a neighbourhood restaurant. Plain, friendly, no exclamation marks." },
);

for await (const text of stream) process.stdout.write(text);

const result = await stream.result;
console.log(`\n\n${result.model} · ${(result.durationMs / 1000).toFixed(1)} s · $${result.apiCostUsd.toFixed(4)} at API prices (not billed)`);
