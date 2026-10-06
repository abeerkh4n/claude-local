import { ClaudeCliError, runClaude, type RunOptions, type RunResult } from "./cli.js";
import { assertSubscription, claudeStatus, type ClaudeStatus } from "./status.js";

export interface ClientOptions extends Omit<RunOptions, "prompt" | "signal"> {
  /** Calls running at once. Each is a separate CLI process. Default 4. */
  concurrency?: number;
  /** Extra attempts after a timeout, a crash or unreadable output. Never after a CLI error such as a usage limit. Default 1. */
  retries?: number;
  /** Check once, before the first call, that the CLI is signed in with a Claude subscription. Default true. */
  requireSubscription?: boolean;
  /** Test seams. */
  statusImpl?: () => ClaudeStatus;
  runImpl?: <T>(options: RunOptions) => Promise<RunResult<T>>;
}

export interface ClientStats {
  calls: number;
  failures: number;
  retries: number;
  /** Sum of what the calls would have cost on the API. Not billed. */
  apiCostUsd: number;
  avgMs: number;
}

export interface ClaudeClient {
  run<T = unknown>(options: RunOptions): Promise<RunResult<T>>;
  /** The reply text. */
  text(prompt: string, options?: Omit<RunOptions, "prompt">): Promise<string>;
  /** The reply parsed against a JSON Schema. */
  json<T = unknown>(prompt: string, jsonSchema: object, options?: Omit<RunOptions, "prompt" | "jsonSchema">): Promise<T>;
  stats(): ClientStats;
}

const TRANSIENT = new Set(["timeout", "exit", "parse"]);

export function createClaude(options: ClientOptions = {}): ClaudeClient {
  const {
    concurrency = 4,
    retries = 1,
    requireSubscription = true,
    statusImpl = claudeStatus,
    runImpl = runClaude,
    ...defaults
  } = options;
  const limit = createLimiter(concurrency);
  const tally = { calls: 0, failures: 0, retries: 0, apiCostUsd: 0, totalMs: 0 };
  let checked = false;

  async function run<T = unknown>(callOptions: RunOptions): Promise<RunResult<T>> {
    if (requireSubscription && !checked) {
      assertSubscription(statusImpl());
      checked = true;
    }
    const merged = withDefaults(defaults, callOptions);
    return limit(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await runImpl<T>(merged);
          tally.calls += 1;
          tally.apiCostUsd += result.apiCostUsd;
          tally.totalMs += result.durationMs;
          return result;
        } catch (err) {
          if (attempt < retries && isTransient(err)) {
            tally.retries += 1;
            continue;
          }
          tally.failures += 1;
          throw err;
        }
      }
    });
  }

  return {
    run,
    text: async (prompt, callOptions) => (await run({ ...callOptions, prompt })).text,
    json: async <T>(prompt: string, jsonSchema: object, callOptions?: Omit<RunOptions, "prompt" | "jsonSchema">) =>
      (await run<T>({ ...callOptions, prompt, jsonSchema })).data as T,
    stats: () => ({
      calls: tally.calls,
      failures: tally.failures,
      retries: tally.retries,
      apiCostUsd: tally.apiCostUsd,
      avgMs: tally.calls ? Math.round(tally.totalMs / tally.calls) : 0,
    }),
  };
}

let shared: ClaudeClient | undefined;

/** The client judge() and simulateConversation() use when you don't pass one. */
export function defaultClient(): ClaudeClient {
  shared ??= createClaude();
  return shared;
}

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

function withDefaults(defaults: Omit<RunOptions, "prompt" | "signal">, call: RunOptions): RunOptions {
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(call)) {
    if (value !== undefined) out[key] = value;
  }
  return out as unknown as RunOptions;
}

function isTransient(err: unknown): boolean {
  return err instanceof ClaudeCliError && TRANSIENT.has(err.kind);
}
