/**
 * LLM-as-judge: grade three candidate replies against facts and criteria.
 * The judge runs on Opus through your subscription, so grading costs no API credit.
 *
 *   npx tsx examples/02-judge.ts
 */
import { createClaude, judge } from "../src/index.js";

const client = createClaude({ concurrency: 3 });

const context = [
  "Menu facts:",
  "- The house pasta is made with wheat flour.",
  "- Gluten-free penne can be swapped into any pasta dish for $3.",
  "- The kitchen is shared and not certified gluten-free.",
].join("\n");

const question = "Guest: Do you have gluten-free pasta? I'm coeliac.";

const replies = {
  overclaims: "Yes! All our pasta is gluten free, so you're completely safe.",
  accurate:
    "We can swap gluten-free penne into any pasta dish for $3. Our kitchen is shared and not certified gluten-free, so there is a risk of cross-contact.",
  unhelpful: "I'm not sure, sorry.",
};

const criteria = [
  "Every factual claim is supported by the menu facts",
  "Answers whether gluten-free pasta is available",
  "Warns a coeliac guest about cross-contact in the shared kitchen",
];

const verdicts = await Promise.all(
  Object.entries(replies).map(async ([name, output]) => ({
    name,
    verdict: await judge({ client, context, input: question, output, criteria }),
  })),
);

for (const { name, verdict } of verdicts) {
  console.log(`\n${verdict.passed ? "PASS" : "FAIL"}  ${name}  (${verdict.score}/10)`);
  for (const c of verdict.criteria) console.log(`  ${c.met ? "✓" : "✗"} ${c.criterion}: ${c.reason}`);
}

const stats = client.stats();
console.log(`\n${stats.calls} judge calls, avg ${stats.avgMs} ms, $${stats.apiCostUsd.toFixed(4)} at API prices (not billed)`);
process.exitCode = verdicts.find((v) => v.name === "accurate")?.verdict.passed ? 0 : 1;
