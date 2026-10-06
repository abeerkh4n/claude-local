import type { Turn } from "../chat.js";
import { claude, type Claude } from "../client.js";

export const DONE = "<<DONE>>";
export const OPENING = "(The conversation is starting. Write your first message.)";

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
  client?: Claude;
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

Each message you receive is exactly what the assistant just said to you. Reply with what you say back.

RULES:
- Write only what you say. No stage directions, no quotation marks, no speaker label.
- Keep it short and natural, the way a real person writes.
- Don't do the assistant's job: give details when asked, or when a real person would offer them.
- When your goal is done, or it clearly can't be done, end your message with ${DONE}. A short goodbye before it is fine.`;
}

/**
 * Plays a simulated user against your system until the user is done or
 * maxTurns runs out. The simulated user is one chat, so it remembers the whole
 * conversation.
 */
export async function simulateConversation(options: SimulateOptions): Promise<Simulation> {
  const { persona, respond, greeting, maxTurns = 10, model = "haiku", client = claude } = options;
  const user = client.chat({ model, system: simulatorSystem(persona) });
  const turns: Turn[] = greeting ? [{ role: "assistant", content: greeting }] : [];
  let heard = greeting ?? OPENING;
  let apiCostUsd = 0;

  try {
    for (let i = 0; i < maxTurns; i++) {
      const result = await user.run(heard);
      apiCostUsd += result.apiCostUsd;
      const { message, done } = splitDone(result.text);
      if (message) turns.push({ role: "user", content: message });
      if (done) return { turns, finished: true, apiCostUsd };
      if (!message) return { turns, finished: false, apiCostUsd };
      heard = await respond(message, turns);
      turns.push({ role: "assistant", content: heard });
    }
    return { turns, finished: false, apiCostUsd };
  } finally {
    await user.close();
  }
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
