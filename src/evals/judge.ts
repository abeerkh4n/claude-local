import type { Effort } from "../cli.js";
import { claude, type Claude } from "../client.js";

export interface JudgeOptions {
  /** Each one is graded met / not met on its own. */
  criteria: string[];
  /** What is being graded: a reply, a summary, a whole transcript. */
  output: string;
  /** What the output was answering, e.g. the question or the conversation so far. */
  input?: string;
  /** Facts the grader may rely on: a menu, a policy, the expected answer. */
  context?: string;
  /** Lowest overall score (0–10) that can pass. Default 7. */
  passMark?: number;
  /** Default "opus". The alias follows your CLI version; pass a full id to pin the judge. */
  model?: string;
  /** How hard the judge thinks before grading. Leave unset for the model's default. */
  effort?: Effort;
  client?: Claude;
}

export interface CriterionResult {
  criterion: string;
  met: boolean;
  reason: string;
}

export interface Verdict {
  /** Every criterion met and score at or above passMark. */
  passed: boolean;
  score: number;
  criteria: CriterionResult[];
  summary: string;
  apiCostUsd: number;
}

export const JUDGE_SYSTEM = `You are a strict, fair evaluator. You grade one output against numbered criteria.
- Judge each criterion on its own. "met" is true only when the output clearly satisfies it.
- Rely only on CONTEXT and INPUT. Anything the output states as fact that they don't support counts as made up.
- Give each criterion a one-sentence reason that points to the words in the output.
- Return the criteria in the order given, with their text unchanged.
- score: 0-10 for the output overall against the criteria. 10 means every criterion is met and nothing is wrong.
- summary: one or two sentences.`;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string" },
          met: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["criterion", "met", "reason"],
      },
    },
    score: { type: "integer", minimum: 0, maximum: 10 },
    summary: { type: "string" },
  },
  required: ["criteria", "score", "summary"],
};

interface RawVerdict {
  criteria: CriterionResult[];
  score: number;
  summary: string;
}

/** LLM-as-judge on your Claude subscription. */
export async function judge(options: JudgeOptions): Promise<Verdict> {
  const { criteria, passMark = 7, model = "opus", effort, client = claude } = options;
  if (!criteria.length) throw new Error("judge() needs at least one criterion");

  const result = await client.run<RawVerdict>(judgePrompt(options), {
    model,
    effort,
    system: JUDGE_SYSTEM,
    jsonSchema: VERDICT_SCHEMA,
  });
  const raw = result.data;
  if (!raw) throw new Error("The judge returned no verdict");

  // Keep the caller's wording; a criterion the judge skipped counts as not met.
  const graded = criteria.map((criterion, i) => {
    const r = raw.criteria[i];
    return r ? { criterion, met: r.met === true, reason: r.reason } : { criterion, met: false, reason: "Not graded." };
  });
  return {
    passed: graded.every((c) => c.met) && raw.score >= passMark,
    score: raw.score,
    criteria: graded,
    summary: raw.summary,
    apiCostUsd: result.apiCostUsd,
  };
}

export function judgePrompt(options: Pick<JudgeOptions, "criteria" | "output" | "input" | "context">): string {
  const sections: string[] = [];
  if (options.context) sections.push(`CONTEXT (facts you may rely on):\n${options.context}`);
  if (options.input) sections.push(`INPUT:\n${options.input}`);
  sections.push(`OUTPUT TO GRADE:\n${options.output}`);
  sections.push(`CRITERIA:\n${options.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  return sections.join("\n\n");
}
