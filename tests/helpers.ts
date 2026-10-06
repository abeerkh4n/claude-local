import { EventEmitter } from "node:events";
import type { ChildLike, RunOptions, RunResult, SpawnLike } from "../src/cli.js";

export const OK_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Two laksas please.",
  total_cost_usd: 0.0008,
  usage: { input_tokens: 174, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { "claude-haiku-4-5-20251001": {} },
};

interface FakeChild extends ChildLike {
  killed?: boolean;
}

interface SpawnCall {
  bin: string;
  args: string[];
  options: Parameters<SpawnLike>[2];
  child: FakeChild;
  stdin: string;
}

/** A spawn that never starts a process: emits the given output, then "close". */
export function fakeSpawn(
  opts: { stdout?: string; stderr?: string; code?: number; hang?: boolean; error?: NodeJS.ErrnoException } = {},
) {
  const calls: SpawnCall[] = [];
  const impl: SpawnLike = (bin, args, options) => {
    const child = new EventEmitter() as EventEmitter & FakeChild;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;
    const call: SpawnCall = { bin, args, options, child, stdin: "" };
    child.stdin = {
      end: (data: string) => {
        call.stdin = data;
      },
      on: () => child,
    };
    child.kill = () => {
      child.killed = true;
      return true;
    };
    calls.push(call);
    if (!opts.hang) {
      setImmediate(() => {
        if (opts.error) return child.emit("error", opts.error);
        if (opts.stdout) stdout.emit("data", opts.stdout);
        if (opts.stderr) stderr.emit("data", opts.stderr);
        child.emit("close", opts.code ?? 0);
      });
    }
    return child;
  };
  return { impl, calls };
}

/** A runClaude stand-in that answers from a list, in order, and records each call. */
export function fakeRun(replies: Array<Partial<RunResult> | Error>) {
  const calls: RunOptions[] = [];
  const impl = async <T>(options: RunOptions): Promise<RunResult<T>> => {
    calls.push(options);
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (next instanceof Error) throw next;
    return {
      text: "",
      data: undefined,
      apiCostUsd: 0.01,
      durationMs: 100,
      model: "fake",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...next,
    } as RunResult<T>;
  };
  return { impl, calls };
}
