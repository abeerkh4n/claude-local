/**
 * Test a chatbot over its HTTP API: a simulated guest talks to the endpoint,
 * then a judge grades the whole conversation.
 *
 *   npx tsx examples/03-chatbot-api.ts
 *
 * To test your real service, delete startDemoBot() and point BOT_URL at it,
 * changing askBot() to match its request and response shape. Only the
 * simulated guest and the judge use your subscription; your bot keeps
 * whatever model and API key it normally uses.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createClaude, formatTranscript, judge, simulateConversation, type Turn } from "../src/index.js";

const client = createClaude();

// ---- A stand-in "chatbot API" so the example runs on its own -------------

const BOT_PROMPT = `You are the booking assistant for Harbour Kitchen.
Open Tuesday to Sunday, 5pm to 10pm. Closed Mondays.
Tables seat up to 8. For larger groups, take a phone number and say a manager will call back.
Never confirm a booking until you have a date, time, party size and name.`;

async function startDemoBot(): Promise<{ url: string; close: () => void }> {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { messages } = JSON.parse(body) as { messages: Turn[] };
    const reply = await client.text(`${formatTranscript(messages)}\n\nWrite the assistant's next reply only.`, {
      model: "haiku",
      system: BOT_PROMPT,
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ reply }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/chat`, close: () => server.close() };
}

// ---- The test --------------------------------------------------------------

const bot = await startDemoBot();
const BOT_URL = bot.url;

async function askBot(turns: readonly Turn[]): Promise<string> {
  const res = await fetch(BOT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: turns }),
  });
  if (!res.ok) throw new Error(`Bot API answered ${res.status}`);
  return ((await res.json()) as { reply: string }).reply;
}

const sim = await simulateConversation({
  client,
  persona:
    "You are Priya. You want a table for 12 people this Monday at 7pm for a birthday. " +
    "Your number is 0491 570 156. You are friendly but in a hurry.",
  greeting: "Hi, thanks for contacting Harbour Kitchen! How can I help?",
  respond: (_message, turns) => askBot(turns),
  maxTurns: 6,
});
bot.close();

console.log(formatTranscript(sim.turns, { user: "GUEST", assistant: "BOT" }));
console.log(`\nGuest finished: ${sim.finished}`);

const verdict = await judge({
  client,
  context: BOT_PROMPT,
  output: formatTranscript(sim.turns, { user: "GUEST", assistant: "BOT" }),
  criteria: [
    "The bot does not offer or confirm a Monday booking",
    "The bot handles the group of 12 by taking a phone number for a manager callback",
    "The bot never confirms a booking",
  ],
});

console.log(`\n${verdict.passed ? "PASS" : "FAIL"} (${verdict.score}/10): ${verdict.summary}`);
for (const c of verdict.criteria) console.log(`  ${c.met ? "✓" : "✗"} ${c.criterion}: ${c.reason}`);

const stats = client.stats();
console.log(`\n${stats.calls} CLI calls, avg ${stats.avgMs} ms, $${stats.apiCostUsd.toFixed(4)} at API prices (not billed)`);
process.exitCode = verdict.passed ? 0 : 1;
