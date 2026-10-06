import { ClaudeCliError, type ModelOptions, type ProcessOptions, type RateLimit, type RunResult } from "./cli.js";
import { createChat, type Chat, type ChatOptions } from "./chat.js";
import { toContent, type FileInput } from "./content.js";
import { runOnce } from "./process.js";
import { assertSubscription, claudeStatus, type ClaudeStatus } from "./status.js";
import { textStream, type TextStream } from "./stream.js";

export interface CallOptions extends ModelOptions {
  /** Images, PDFs or text files to send with the prompt: paths, or { data, mediaType }. */
  files?: readonly FileInput[];
  /** Longest the reply may take. Default 5 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each piece of reply text as it is written. */
  onText?: (text: string) => void;
}

export interface ClientOptions extends ModelOptions, ProcessOptions {
  /** Calls running at once. Each is a separate CLI process. Default 4. */
  concurrency?: number;
  /** Extra attempts after a timeout, a crash or unreadable output. Never after a CLI error or a usage limit. Default 1. */
  retries?: number;
  timeoutMs?: number;
  /** Check once, before the first call, that the CLI is signed in with a Claude subscription. Default true. */
  requireSubscription?: boolean;
  /** Test seam. */
  statusImpl?: () => ClaudeStatus;
}

export interface ClientStats {
  calls: number;
  failures: number;
  retries: number;
  /** Sum of what the calls would have cost on the API. Not billed. */
  apiCostUsd: number;
  avgMs: number;
  /** The plan's usage window as of the latest call. */
  rateLimit: RateLimit | undefined;
}

export interface Claude {
  /** One prompt, one reply. Each call is independent. */
  ask(prompt: string, options?: CallOptions): Promise<string>;
  /** The reply as JSON matching the schema, parsed. */
  json<T = unknown>(prompt: string, jsonSchema: object, options?: Omit<CallOptions, "jsonSchema">): Promise<T>;
  /** The reply text as it is written: `for await (const text of claude.stream(...))`. */
  stream(prompt: string, options?: Omit<CallOptions, "onText">): TextStream;
  /** Like ask(), with the full result: text, data, cost, time, model, usage. */
  run<T = unknown>(prompt: string, options?: CallOptions): Promise<RunResult<T>>;
  /** A multi-turn conversation that remembers what was said. */
  chat(options?: ChatOptions): Chat;
  stats(): ClientStats;
}

const TRANSIENT = new Set(["timeout", "exit", "parse"]);

export function createClaude(options: ClientOptions = {}): Claude {
  const {
    concurrency = 4,
    retries = 1,
    requireSubscription = true,
    statusImpl = claudeStatus,
    ...defaults
  } = options;
  const limit = createLimiter(concurrency);
  const tally = { calls: 0, failures: 0, retries: 0, apiCostUsd: 0, totalMs: 0 };
  let rateLimit: RateLimit | undefined;
  let checked = false;

  const ensureLogin = () => {
    if (!requireSubscription || checked) return;
    assertSubscription(statusImpl());
    checked = true;
  };
  const recordSuccess = (result: RunResult) => {
    tally.calls += 1;
    tally.apiCostUsd += result.apiCostUsd;
    tally.totalMs += result.durationMs;
    rateLimit = result.rateLimit ?? rateLimit;
  };
  const recordFailure = () => {
    tally.failures += 1;
  };

  async function run<T = unknown>(prompt: string, callOptions: CallOptions = {}): Promise<RunResult<T>> {
    ensureLogin();
    const { files, onText, signal, ...rest } = callOptions;
    const settings = withDefaults(defaults, rest);
    const content = await toContent(prompt, files);
    return limit(async () => {
      let wrote = false;
      const forward = onText
        ? (text: string) => {
            wrote = true;
            onText(text);
          }
        : undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await runOnce<T>(content, { ...settings, onText: forward, signal });
          recordSuccess(result);
          return result;
        } catch (err) {
          // A retry after text has gone to the caller would repeat it.
          if (attempt < retries && !wrote && isTransient(err)) {
            tally.retries += 1;
            continue;
          }
          recordFailure();
          throw err;
        }
      }
    });
  }

  return {
    run,
    ask: async (prompt, callOptions) => (await run(prompt, callOptions)).text,
    json: async <T>(prompt: string, jsonSchema: object, callOptions?: Omit<CallOptions, "jsonSchema">) =>
      (await run<T>(prompt, { ...callOptions, jsonSchema })).data as T,
    stream: (prompt, callOptions) => textStream((onText) => run(prompt, { ...callOptions, onText })),
    chat: (chatOptions = {}) =>
      createChat({
        settings: withDefaults(defaults, chatOptions),
        limit,
        ensureLogin,
        recordSuccess,
        recordFailure,
      }),
    stats: () => ({
      calls: tally.calls,
      failures: tally.failures,
      retries: tally.retries,
      apiCostUsd: tally.apiCostUsd,
      avgMs: tally.calls ? Math.round(tally.totalMs / tally.calls) : 0,
      rateLimit,
    }),
  };
}

/** A ready client with the default settings. Nothing starts until the first call. */
export const claude: Claude = createClaude();

/** Runs at most `max` tasks at once; the rest wait in order. */
export function createLimiter(max: number) {
  const size = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= size) return;
    const job = queue.shift();
    if (!job) return;
    active += 1;
    job();
  };
  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
  };
}

/** Call options win over client defaults, except where the call leaves an option undefined. */
function withDefaults<D extends object, C extends object>(defaults: D, call: C): D & C {
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [key, value] of Object.entries(call)) {
    if (value !== undefined) out[key] = value;
  }
  return out as D & C;
}

function isTransient(err: unknown): boolean {
  return err instanceof ClaudeCliError && TRANSIENT.has(err.kind);
}
