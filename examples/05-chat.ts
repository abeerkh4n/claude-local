/**
 * A chat in your terminal. The conversation stays in one CLI process, so
 * Claude remembers everything said and each reply starts in about a second.
 *
 *   npx tsx examples/05-chat.ts
 *
 * Type a message and press Enter. An empty line or Ctrl+D ends the chat.
 */
import { createInterface } from "node:readline";
import { claude } from "../src/index.js";

const chat = claude.chat({
  model: "sonnet",
  system: "You are a sharp, friendly assistant. Keep answers short unless asked for detail.",
});
const lines = createInterface({ input: process.stdin });

console.log("Chatting with Claude on your subscription. Empty line or Ctrl+D to quit.\n");
process.stdout.write("you › ");
for await (const line of lines) {
  if (!line.trim()) break;
  process.stdout.write("claude › ");
  for await (const text of chat.stream(line)) process.stdout.write(text);
  process.stdout.write("\n\nyou › ");
}

lines.close();
await chat.close();
const stats = claude.stats();
console.log(`\n${stats.calls} replies · $${stats.apiCostUsd.toFixed(4)} at API prices (not billed)`);
