import { describe, expect, it } from "vitest";
import { createClaude } from "../../src/client.js";
import { formatTranscript, judge, judgePrompt, OPENING, simulateConversation, splitDone } from "../../src/evals/index.js";
import { fakeCli, SIGNED_IN, type FakeReply } from "../helpers.js";

function client(replies: FakeReply[]) {
  const fake = fakeCli(replies);
  return { claude: createClaude({ spawnImpl: fake.impl, statusImpl: () => SIGNED_IN }), spawns: fake.spawns };
}

const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("judge", () => {
  const criteria = ["States only facts from the context", "Answers the question"];
  const met = { criterion: "", met: true, reason: "r" };

  it("sends context, input, output and numbered criteria to the judge model with a schema", async () => {
    const { claude, spawns } = client([{ data: { criteria: [met, met], score: 9, summary: "Good." } }]);
    const verdict = await judge({ client: claude, criteria, context: "C", input: "Q", output: "A" });
    const s = spawns[0]!;
    expect(arg(s.args, "--model")).toBe("opus");
    expect(s.args).toContain("--json-schema");
    expect(s.args).not.toContain("--effort");
    expect(s.messages[0]!.content).toBe(judgePrompt({ criteria, context: "C", input: "Q", output: "A" }));
    expect(verdict).toMatchObject({ passed: true, score: 9, summary: "Good." });
    expect(verdict.criteria.map((c) => c.criterion)).toEqual(criteria);
  });

  it("passes a chosen judge model and effort through", async () => {
    const { claude, spawns } = client([{ data: { criteria: [met, met], score: 9, summary: "" } }]);
    await judge({ client: claude, criteria, output: "A", model: "claude-opus-5", effort: "medium" });
    expect(arg(spawns[0]!.args, "--model")).toBe("claude-opus-5");
    expect(arg(spawns[0]!.args, "--effort")).toBe("medium");
  });

  it("fails when any criterion is unmet, when the score is under the pass mark, or when a criterion was skipped", async () => {
    const run = async (data: object, passMark?: number) =>
      judge({ client: client([{ data }]).claude, criteria, output: "A", passMark });
    expect((await run({ criteria: [met, { ...met, met: false }], score: 9, summary: "" })).passed).toBe(false);
    expect((await run({ criteria: [met, met], score: 6, summary: "" })).passed).toBe(false);
    expect((await run({ criteria: [met, met], score: 6, summary: "" }, 5)).passed).toBe(true);
    const skipped = await run({ criteria: [met], score: 9, summary: "" });
    expect(skipped.passed).toBe(false);
    expect(skipped.criteria[1]).toMatchObject({ met: false, reason: "Not graded." });
  });

  it("puts sections in a fixed order and leaves out empty ones", () => {
    expect(judgePrompt({ criteria: ["a", "b"], output: "OUT" })).toBe("OUTPUT TO GRADE:\nOUT\n\nCRITERIA:\n1. a\n2. b");
  });
});

describe("simulateConversation", () => {
  it("the simulated user is one chat that hears each bot reply; ends when it says it's done", async () => {
    const { claude, spawns } = client(["Table for 2 tonight?", "YOU: 7pm works, thanks! <<DONE>>"]);
    const seen: number[] = [];
    const sim = await simulateConversation({
      client: claude,
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
    expect(spawns).toHaveLength(1);
    expect(arg(spawns[0]!.args, "--model")).toBe("haiku");
    expect(arg(spawns[0]!.args, "--system-prompt")).toMatch(/Wants a table for 2 tonight/);
    expect(spawns[0]!.messages.map((m) => m.content)).toEqual(["Hi, how can I help?", "We have 7pm."]);
    expect(spawns[0]!.stdinEnded).toBe(true);
    expect(sim.apiCostUsd).toBeCloseTo(0.02);
  });

  it("without a greeting the user opens; stops at maxTurns without finishing", async () => {
    const { claude, spawns } = client(["Hello?"]);
    const sim = await simulateConversation({ client: claude, persona: "p", maxTurns: 3, respond: async () => "..." });
    expect(sim.finished).toBe(false);
    expect(sim.turns.filter((t) => t.role === "user")).toHaveLength(3);
    expect(spawns[0]!.messages[0]!.content).toBe(OPENING);
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
