import { describe, expect, it } from "vitest";
import { createClaude } from "../src/client.js";
import { judge, judgePrompt } from "../src/judge.js";
import { simulateConversation, simulatorPrompt, splitDone } from "../src/simulate.js";
import { formatTranscript } from "../src/transcript.js";
import { fakeRun } from "./helpers.js";

describe("judge", () => {
  const criteria = ["States only facts from the context", "Answers the question"];

  it("sends context, input, output and numbered criteria to the judge model with a schema", async () => {
    const { impl, calls } = fakeRun([
      { data: { criteria: [{ criterion: "x", met: true, reason: "r1" }, { criterion: "y", met: true, reason: "r2" }], score: 9, summary: "Good." } },
    ]);
    const client = createClaude({ runImpl: impl, requireSubscription: false });
    const verdict = await judge({ client, criteria, context: "C", input: "Q", output: "A" });
    expect(calls[0]!.model).toBe("opus");
    expect(calls[0]!.effort).toBeUndefined();
    expect(calls[0]!.jsonSchema).toBeDefined();
    expect(calls[0]!.prompt).toBe(judgePrompt({ criteria, context: "C", input: "Q", output: "A" }));
    expect(verdict).toMatchObject({ passed: true, score: 9, summary: "Good." });
    // The caller's wording is kept, not the judge's.
    expect(verdict.criteria.map((c) => c.criterion)).toEqual(criteria);
  });

  it("fails when any criterion is unmet, when the score is under the pass mark, or when a criterion was skipped", async () => {
    const run = async (data: object, passMark?: number) => {
      const { impl } = fakeRun([{ data }]);
      return judge({ client: createClaude({ runImpl: impl, requireSubscription: false }), criteria, output: "A", passMark });
    };
    const met = { criterion: "", met: true, reason: "" };
    expect((await run({ criteria: [met, { ...met, met: false }], score: 9, summary: "" })).passed).toBe(false);
    expect((await run({ criteria: [met, met], score: 6, summary: "" })).passed).toBe(false);
    expect((await run({ criteria: [met, met], score: 6, summary: "" }, 5)).passed).toBe(true);
    const skipped = await run({ criteria: [met], score: 9, summary: "" });
    expect(skipped.passed).toBe(false);
    expect(skipped.criteria[1]).toMatchObject({ met: false, reason: "Not graded." });
  });

  it("passes a chosen judge model and effort through", async () => {
    const met = { criterion: "", met: true, reason: "" };
    const { impl, calls } = fakeRun([{ data: { criteria: [met, met], score: 9, summary: "" } }]);
    const client = createClaude({ runImpl: impl, requireSubscription: false });
    await judge({ client, criteria, output: "A", model: "claude-opus-5", effort: "medium" });
    expect(calls[0]).toMatchObject({ model: "claude-opus-5", effort: "medium" });
  });

  it("puts sections in a fixed order and leaves out empty ones", () => {
    expect(judgePrompt({ criteria: ["a", "b"], output: "OUT" })).toBe("OUTPUT TO GRADE:\nOUT\n\nCRITERIA:\n1. a\n2. b");
  });
});

describe("simulateConversation", () => {
  it("alternates simulated user and system under test until the user says it's done", async () => {
    const { impl, calls } = fakeRun([{ text: "Table for 2 tonight?" }, { text: "YOU: 7pm works, thanks! <<DONE>>" }]);
    const client = createClaude({ runImpl: impl, requireSubscription: false });
    const seen: number[] = [];
    const sim = await simulateConversation({
      client,
      persona: "Wants a table for 2 tonight.",
      greeting: "Hi, how can I help?",
      respond: async (message, turns) => {
        seen.push(turns.length);
        expect(turns.at(-1)).toEqual({ role: "user", content: message });
        return "We have 7pm.";
      },
    });
    expect(sim.finished).toBe(true);
    expect(sim.turns).toEqual([
      { role: "assistant", content: "Hi, how can I help?" },
      { role: "user", content: "Table for 2 tonight?" },
      { role: "assistant", content: "We have 7pm." },
      { role: "user", content: "7pm works, thanks!" },
    ]);
    expect(seen).toEqual([2]);
    expect(calls[0]!.model).toBe("haiku");
    expect(calls[0]!.system).toMatch(/Wants a table for 2 tonight/);
    expect(calls[1]!.prompt).toContain("ASSISTANT: Hi, how can I help?\nYOU: Table for 2 tonight?\nASSISTANT: We have 7pm.");
    expect(sim.apiCostUsd).toBeCloseTo(0.02);
  });

  it("stops at maxTurns without finishing", async () => {
    const { impl } = fakeRun([{ text: "Hello?" }]);
    const client = createClaude({ runImpl: impl, requireSubscription: false });
    const sim = await simulateConversation({ client, persona: "p", maxTurns: 3, respond: async () => "..." });
    expect(sim.finished).toBe(false);
    expect(sim.turns.filter((t) => t.role === "user")).toHaveLength(3);
  });

  it("first prompt says nobody has spoken yet", () => {
    expect(simulatorPrompt([])).toMatch(/hasn't started/);
  });

  it("splitDone strips the marker and a copied speaker label", () => {
    expect(splitDone("Bye! <<DONE>>")).toEqual({ message: "Bye!", done: true });
    expect(splitDone("<<DONE>>")).toEqual({ message: "", done: true });
    expect(splitDone("You know what, 8pm.")).toEqual({ message: "You know what, 8pm.", done: false });
  });
});

describe("formatTranscript", () => {
  it("labels each turn", () => {
    expect(formatTranscript([{ role: "user", content: "a" }, { role: "assistant", content: "b" }])).toBe("USER: a\nASSISTANT: b");
  });
});
