import { defaultClient, type ClaudeClient } from "./client.js";
import { formatTranscript, type Turn } from "./transcript.js";

export const DONE = "<<DONE>>";

export interface SimulateOptions {
  /** Who the simulated user is and what they want, in plain words. */
  persona: string;
  /** The system under test: your bot, prompt or HTTP endpoint. Gets the user's message and every turn so far, ending with that message. */
  respond: (message: string, turns: readonly Turn[]) => Promise<string>;
  /** The assistant's opening line, when it speaks first. */
  greeting?: string;
  /** Most messages the simulated user sends. Default 10. */
  maxTurns?: number;
  /** Default "haiku". */
  model?: string;
  client?: ClaudeClient;
}

export interface Simulation {
  /** "user" is the simulated user, "assistant" is the system under test. */
  turns: Turn[];
  /** The simulated user said its goal was done (or could not be done) before maxTurns. */
  finished: boolean;
  apiCostUsd: number;
}

export function simulatorSystem(persona: string): string {
  return `You are role-playing a person talking to an assistant, to test it. Stay in character the whole time.

WHO YOU ARE AND WHAT YOU WANT:
${persona}

RULES:
- Write only what you say next. No stage directions, no quotation marks, no speaker label.
- Keep it short and natural, the way a real person writes.
- Don't do the assistant's job: give details when asked, or when a real person would offer them.
- When your goal is done, or it clearly can't be done, end your message with ${DONE}. A short goodbye before it is fine.`;
}

export function simulatorPrompt(turns: readonly Turn[]): string {
  if (!turns.length) return "The conversation hasn't started. Write your first message.";
  const transcript = formatTranscript(turns, { user: "YOU", assistant: "ASSISTANT" });
  return `The conversation so far (YOU are you; ASSISTANT is who you are talking to):\n\n${transcript}\n\nWrite your next message.`;
}

/** Plays a simulated user against your system until the user is done or maxTurns runs out. */
export async function simulateConversation(options: SimulateOptions): Promise<Simulation> {
  const { persona, respond, greeting, maxTurns = 10, model = "haiku", client = defaultClient() } = options;
  const system = simulatorSystem(persona);
  const turns: Turn[] = greeting ? [{ role: "assistant", content: greeting }] : [];
  let apiCostUsd = 0;

  for (let i = 0; i < maxTurns; i++) {
    const result = await client.run({ model, system, prompt: simulatorPrompt(turns) });
    apiCostUsd += result.apiCostUsd;
    const { message, done } = splitDone(result.text);
    if (message) turns.push({ role: "user", content: message });
    if (done) return { turns, finished: true, apiCostUsd };
    if (!message) return { turns, finished: false, apiCostUsd };
    turns.push({ role: "assistant", content: await respond(message, turns) });
  }
  return { turns, finished: false, apiCostUsd };
}

export function splitDone(text: string): { message: string; done: boolean } {
  const done = text.includes(DONE);
  const message = text
    .split(DONE)
    .join("")
    .trim()
    .replace(/^(?:YOU|USER)\s*:\s*/i, "");
  return { message, done };
}
