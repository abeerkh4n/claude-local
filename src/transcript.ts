export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/**
 * The CLI takes one prompt, not a list of messages, so a conversation is sent
 * as a labelled transcript inside that prompt.
 */
export function formatTranscript(
  turns: readonly Turn[],
  labels: { user: string; assistant: string } = { user: "USER", assistant: "ASSISTANT" },
): string {
  return turns.map((t) => `${labels[t.role]}: ${t.content}`).join("\n");
}
