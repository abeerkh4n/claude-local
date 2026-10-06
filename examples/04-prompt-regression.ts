/**
 * Prompt regression check: run a prompt over a table of cases and fail if any
 * answer changes. Run it before you ship a prompt edit.
 *
 *   npx tsx examples/04-prompt-regression.ts
 */
import { createClaude } from "../src/index.js";

const PROMPT_UNDER_TEST = `You route messages sent to a restaurant.
Pick exactly one intent:
- book: wants a new reservation
- change: wants to move or edit an existing reservation
- cancel: wants to cancel a reservation
- order: wants food for pickup or delivery
- question: anything else (hours, parking, menu, allergies)`;

const INTENT_SCHEMA = {
  type: "object",
  properties: { intent: { type: "string", enum: ["book", "change", "cancel", "order", "question"] } },
  required: ["intent"],
};

const cases = [
  { message: "table for 2 tonight around 8?", want: "book" },
  { message: "can we push our 7pm to 7:30", want: "change" },
  { message: "something came up, won't make it Friday, sorry", want: "cancel" },
  { message: "two margheritas for pickup please", want: "order" },
  { message: "is there parking nearby", want: "question" },
  { message: "we're now 6 people instead of 4 for Saturday", want: "change" },
];

const claude = createClaude({ model: "haiku", system: PROMPT_UNDER_TEST, concurrency: 6 });

const results = await Promise.all(
  cases.map(async (c) => {
    const { intent } = await claude.json<{ intent: string }>(c.message, INTENT_SCHEMA);
    return { ...c, got: intent };
  }),
);

for (const r of results) console.log(`${r.got === r.want ? "✓" : "✗"} ${r.message.padEnd(52)} → ${r.got} (want ${r.want})`);

const failed = results.filter((r) => r.got !== r.want).length;
const stats = claude.stats();
console.log(`\n${cases.length - failed}/${cases.length} correct · ${stats.calls} calls, avg ${stats.avgMs} ms, $${stats.apiCostUsd.toFixed(4)} at API prices (not billed)`);
process.exitCode = failed ? 1 : 0;
