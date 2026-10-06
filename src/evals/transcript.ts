import type { Turn } from "../chat.js";

/** Writes a conversation out as labelled lines, e.g. for a judge to read. */
export function formatTranscript(
  turns: readonly Turn[],
  labels: { user: string; assistant: string } = { user: "USER", assistant: "ASSISTANT" },
): string {
  return turns.map((t) => `${labels[t.role]}: ${t.content}`).join("\n");
}
