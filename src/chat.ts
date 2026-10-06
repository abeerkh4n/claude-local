import type { ModelOptions, ProcessOptions, RunResult } from "./cli.js";
import { toContent, type FileInput } from "./content.js";
import { CliProcess } from "./process.js";
import { textStream, type TextStream } from "./stream.js";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatOptions extends ModelOptions {
  /** Longest one reply may take. */
  timeoutMs?: number;
}

export interface MessageOptions {
  files?: readonly FileInput[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
}

export interface Chat {
  /** Sends a message and returns the reply text. Messages queue: each waits for the previous reply. */
  send(message: string, options?: MessageOptions): Promise<string>;
  /** Like send(), with the full result. */
  run<T = unknown>(message: string, options?: MessageOptions): Promise<RunResult<T>>;
  /** Like send(), with the reply text as it is written. */
  stream(message: string, options?: Omit<MessageOptions, "onText">): TextStream;
  /** Every message and reply so far. */
  readonly turns: readonly Turn[];
  /** Ends the conversation. An idle chat does not keep Node running, but close it when you are done. */
  close(): Promise<void>;
}

/** What a chat borrows from its client: settings, the concurrency limit, the login check and the totals. */
export interface ChatRuntime {
  settings: ModelOptions & ProcessOptions & { timeoutMs?: number };
  limit: <T>(task: () => Promise<T>) => Promise<T>;
  ensureLogin: () => void;
  recordSuccess: (result: RunResult) => void;
  recordFailure: () => void;
}

/** A conversation kept in one CLI process, so every turn sees the real history and skips the startup cost. */
export function createChat(runtime: ChatRuntime): Chat {
  const { settings } = runtime;
  const proc = new CliProcess({ ...settings, partial: true });
  const turns: Turn[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  async function turn<T>(message: string, options: MessageOptions): Promise<RunResult<T>> {
    runtime.ensureLogin();
    const content = await toContent(message, options.files);
    try {
      const result = await runtime.limit(() =>
        proc.send<T>(content, { onText: options.onText, signal: options.signal, timeoutMs: settings.timeoutMs }),
      );
      turns.push({ role: "user", content: message }, { role: "assistant", content: result.text });
      runtime.recordSuccess(result);
      return result;
    } catch (err) {
      runtime.recordFailure();
      throw err;
    }
  }

  function run<T = unknown>(message: string, options: MessageOptions = {}): Promise<RunResult<T>> {
    const next = queue.then(() => turn<T>(message, options));
    queue = next.catch(() => {});
    return next;
  }

  return {
    run,
    send: async (message, options) => (await run(message, options)).text,
    stream: (message, options) => textStream((onText) => run(message, { ...options, onText })),
    get turns() {
      return turns;
    },
    close: () => proc.close(),
  };
}
