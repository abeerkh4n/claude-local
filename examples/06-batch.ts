/**
 * Many items at once: tag a pile of guest reviews. Calls run side by side
 * (four at a time by default; set `concurrency` to change it).
 *
 *   npx tsx examples/06-batch.ts
 */
import { createClaude } from "../src/index.js";

const reviews = [
  "Best laksa in the city, but we waited 40 minutes for a table even with a booking.",
  "Staff were lovely with our toddler. Chips were cold though.",
  "Overpriced for the portion size. Won't be back.",
  "The new brunch menu is fantastic, the shakshuka especially.",
  "Couldn't hear each other over the music. Food was fine.",
  "Booked online for 6, arrived to find a table for 4. Manager sorted it quickly.",
];

const schema = {
  type: "object",
  properties: {
    sentiment: { type: "string", enum: ["positive", "mixed", "negative"] },
    topics: { type: "array", items: { type: "string", enum: ["food", "service", "wait", "price", "noise", "booking", "kids"] } },
    reply: { type: "string", description: "A one-sentence reply from the owner" },
  },
  required: ["sentiment", "topics", "reply"],
};

const claude = createClaude({ model: "haiku", concurrency: 6 });

const tagged = await Promise.all(
  reviews.map((review) =>
    claude.json<{ sentiment: string; topics: string[]; reply: string }>(`Tag this review:\n\n${review}`, schema),
  ),
);

tagged.forEach((t, i) => {
  console.log(`${t.sentiment.padEnd(8)} ${t.topics.join(", ").padEnd(22)} ${reviews[i]!.slice(0, 50)}…`);
  console.log(`         ↳ ${t.reply}`);
});

const stats = claude.stats();
console.log(`\n${stats.calls} calls, avg ${stats.avgMs} ms each, $${stats.apiCostUsd.toFixed(4)} at API prices (not billed)`);
