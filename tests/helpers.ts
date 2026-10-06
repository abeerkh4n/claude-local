import { EventEmitter } from "node:events";
import type { ChildLike, SpawnLike } from "../src/cli.js";
import type { ClaudeStatus } from "../src/status.js";

export const SIGNED_IN: ClaudeStatus = { installed: true, loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };

/** How the fake CLI answers one user message. A string is a plain text reply. */
export type FakeReply =
  | string
  | {
      text?: string;
      data?: unknown;
      /** Text written piece by piece before the result. */
      deltas?: string[];
      /** Thinking written before the text; must never reach onText. */
      thinking?: string[];
      /** An error result with this message. */
      error?: string;
      /** Rate-limit status reported before the result. */
      rateLimit?: string;
      /** This turn's cost; the fake reports a running total like the real CLI. */
      cost?: number;
      /** Exit with code 1 instead of answering (after any deltas). */
      crash?: boolean;
      /** Never answer. */
      hang?: boolean;
      /** Print a non-JSON line first, and split the result line across two chunks. */
      noisy?: boolean;
    };

export interface FakeSpawn {
  bin: string;
  args: string[];
  options: Parameters<SpawnLike>[2];
  /** The `message` of every user line written to stdin. */
  messages: Array<{ role: string; content: unknown }>;
  killed: boolean;
  stdinEnded: boolean;
}

/** A spawn that never starts a process: it speaks the CLI's stream-json protocol from a script. */
export function fakeCli(replies: FakeReply[], opts: { stderr?: string; spawnError?: NodeJS.ErrnoException } = {}) {
  const spawns: FakeSpawn[] = [];
  let next = 0;

  const impl: SpawnLike = (bin, args, options) => {
    const child = new EventEmitter() as EventEmitter & ChildLike;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const record: FakeSpawn = { bin, args, options, messages: [], killed: false, stdinEnded: false };
    let total = 0;
    let closed = false;
    const close = (code: number | null) => {
      if (closed) return;
      closed = true;
      setImmediate(() => child.emit("close", code));
    };
    const emit = (event: object) => stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));

    const answer = (reply: FakeReply) => {
      const r = typeof reply === "string" ? { text: reply } : reply;
      if (r.hang) return;
      if (r.noisy) stdout.emit("data", "Warning: something unrelated\n");
      if (r.rateLimit) {
        emit({ type: "rate_limit_event", rate_limit_info: { status: r.rateLimit, resetsAt: 1791328200, rateLimitType: "five_hour" } });
      }
      for (const t of r.thinking ?? []) {
        emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: t } } });
      }
      for (const t of r.deltas ?? []) {
        emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
      }
      if (r.crash) {
        if (opts.stderr) stderr.emit("data", opts.stderr);
        return close(1);
      }
      total += r.cost ?? 0.01;
      const line = `${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: Boolean(r.error),
        result: r.error ?? r.text ?? (r.deltas ?? []).join(""),
        structured_output: r.data,
        total_cost_usd: total,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: { "claude-haiku-4-5-20251001": {} },
      })}\n`;
      if (!r.noisy) return stdout.emit("data", line);
      const half = Math.floor(line.length / 2);
      stdout.emit("data", line.slice(0, half));
      stdout.emit("data", line.slice(half));
    };

    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = {
      write: (data: string) => {
        const parsed = JSON.parse(data) as { message: { role: string; content: unknown } };
        record.messages.push(parsed.message);
        const reply = replies[Math.min(next++, replies.length - 1)]!;
        setImmediate(() => answer(reply));
        return true;
      },
      end: () => {
        record.stdinEnded = true;
        close(0);
      },
      on: () => child,
    };
    child.kill = () => {
      record.killed = true;
      close(null);
      return true;
    };
    spawns.push(record);
    if (opts.spawnError) setImmediate(() => child.emit("error", opts.spawnError!));
    return child;
  };

  return { impl, spawns };
}
