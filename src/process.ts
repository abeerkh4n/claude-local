import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  ClaudeCliError,
  cliArgs,
  cliEnv,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  type ChildLike,
  type ModelOptions,
  type ProcessOptions,
  type RateLimit,
  type RunResult,
  type SpawnLike,
  type Usage,
} from "./cli.js";
import type { ContentBlock } from "./content.js";

const defaultSpawn: SpawnLike = (bin, args, options) => spawn(bin, args, options);

let workDir: string | undefined;

/**
 * Every process runs from one empty temp folder, so the CLI finds no CLAUDE.md,
 * project settings or project memory to add to the prompt.
 */
export function emptyWorkDir(): string {
  if (workDir) return workDir;
  const dir = mkdtempSync(join(tmpdir(), "claude-local-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  workDir = dir;
  return dir;
}

export interface CliProcessOptions extends ModelOptions, ProcessOptions {
  /** Report text as it is written (needed for onText). */
  partial?: boolean;
}

export interface SendOptions {
  /** Called with each piece of reply text as it is written. Needs `partial`. */
  onText?: (text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Pending {
  resolve: (result: RunResult<unknown>) => void;
  reject: (err: Error) => void;
  onText: ((text: string) => void) | undefined;
  started: number;
  cleanup: () => void;
}

type Event = Record<string, unknown>;

/**
 * One `claude -p` process in streaming JSON mode. Each send() is one user turn,
 * and the process remembers the conversation until close(). Turns must not
 * overlap: the CLI merges a message sent mid-reply into the same turn.
 */
export class CliProcess {
  private child: ChildLike | undefined;
  private pending: Pending | undefined;
  private readonly decoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private stderr = "";
  private costSoFar = 0;
  private rateLimit: RateLimit | undefined;
  /** Set once the process can take no more turns, with the reason. */
  private dead: ClaudeCliError | undefined;
  private exited: Promise<void> = Promise.resolve();

  constructor(private readonly options: CliProcessOptions) {}

  send<T = unknown>(content: string | ContentBlock[], options: SendOptions = {}): Promise<RunResult<T>> {
    if (this.dead) return Promise.reject(this.dead);
    if (this.pending) return Promise.reject(new Error("send() called while the previous reply is still being written"));
    const { onText, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    if (signal?.aborted) return Promise.reject(new ClaudeCliError("aborted", "Aborted before the call started"));

    const child = this.child ?? this.start();
    return new Promise<RunResult<T>>((resolve, reject) => {
      const timer = setTimeout(
        () => this.kill(new ClaudeCliError("timeout", `Claude CLI timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      const onAbort = () => this.kill(new ClaudeCliError("aborted", "Aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        resolve: resolve as (result: RunResult<unknown>) => void,
        reject,
        onText,
        started: Date.now(),
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      this.setActive(true);
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
    });
  }

  /** Ends the conversation and waits for the process to exit. Safe to call more than once. */
  close(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    this.dead ??= new ClaudeCliError("closed", "This conversation is closed. Start a new one.");
    // Keep Node running until the CLI has exited.
    this.setActive(true);
    child.stdin.end();
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    return this.exited.finally(() => clearTimeout(force));
  }

  private start(): ChildLike {
    const { bin = "claude", env = process.env, spawnImpl = defaultSpawn } = this.options;
    const child = spawnImpl(bin, cliArgs(this.options), {
      cwd: emptyWorkDir(),
      env: cliEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let markExited = () => {};
    this.exited = new Promise((resolve) => (markExited = resolve));

    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-4_000);
    });
    child.on("error", (err) => {
      markExited();
      this.fail(spawnError(err, bin));
    });
    child.on("close", (code) => {
      markExited();
      const detail = preview(this.stderr);
      this.fail(new ClaudeCliError("exit", `Claude CLI exited (code ${code})${detail ? `: ${detail}` : ""}`));
    });
    // The CLI can exit before reading stdin (bad flag, not signed in); "close" reports why.
    child.stdin.on("error", () => {});
    return child;
  }

  /** Stops the process and fails the turn in progress with `err`. */
  private kill(err: ClaudeCliError) {
    this.fail(err);
    this.child?.kill("SIGKILL");
  }

  /** No more turns: reject the one in progress, if any. The first reason wins. */
  private fail(err: ClaudeCliError) {
    this.dead ??= err;
    const pending = this.takePending();
    pending?.reject(this.dead.kind === "closed" ? err : this.dead);
  }

  private takePending(): Pending | undefined {
    const pending = this.pending;
    this.pending = undefined;
    pending?.cleanup();
    this.setActive(false);
    return pending;
  }

  /** An idle conversation must not keep Node running; the CLI exits when stdin closes. */
  private setActive(active: boolean) {
    const child = this.child;
    if (!child) return;
    for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
      if (active) handle.ref?.();
      else handle.unref?.();
    }
  }

  private onStdout(chunk: Buffer | string) {
    this.lineBuffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let newline = this.lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line.startsWith("{")) this.onEvent(parseLine(line));
      newline = this.lineBuffer.indexOf("\n");
    }
  }

  private onEvent(event: Event | undefined) {
    if (!event) return;
    if (event.type === "rate_limit_event") this.rateLimit = readRateLimit(event.rate_limit_info);
    if (event.type === "stream_event") this.onStreamEvent(event.event);
    if (event.type === "result") this.onResult(event);
  }

  private onStreamEvent(raw: unknown) {
    const event = raw as { type?: string; delta?: { type?: string; text?: unknown } } | undefined;
    if (event?.type !== "content_block_delta" || event.delta?.type !== "text_delta") return;
    if (typeof event.delta.text === "string") this.pending?.onText?.(event.delta.text);
  }

  private onResult(r: Event) {
    // total_cost_usd is a running total for the process; this turn's cost is the difference.
    const total = num(r.total_cost_usd);
    const apiCostUsd = Math.max(0, total - this.costSoFar);
    this.costSoFar = total;
    const pending = this.takePending();
    if (!pending) return;

    if (r.is_error === true || r.subtype !== "success") {
      const kind = this.rateLimit?.status === "rejected" ? "usage_limit" : "cli_error";
      return pending.reject(new ClaudeCliError(kind, `Claude CLI error: ${errorMessage(r)}`));
    }
    const text = typeof r.result === "string" ? r.result : "";
    let data = r.structured_output;
    if (this.options.jsonSchema && data === undefined) {
      try {
        data = JSON.parse(text);
      } catch {
        return pending.reject(new ClaudeCliError("parse", `Asked for JSON but got: ${preview(text) || "(empty reply)"}`));
      }
    }
    pending.resolve({
      text,
      data,
      apiCostUsd,
      durationMs: Date.now() - pending.started,
      model: answeringModel(r.modelUsage, this.options.model),
      usage: readUsage(r.usage),
      rateLimit: this.rateLimit,
    });
  }
}

/** One prompt in a fresh process: no memory of other calls. */
export async function runOnce<T = unknown>(
  content: string | ContentBlock[],
  options: CliProcessOptions & SendOptions,
): Promise<RunResult<T>> {
  const proc = new CliProcess({ ...options, partial: options.partial ?? Boolean(options.onText) });
  try {
    return await proc.send<T>(content, options);
  } finally {
    await proc.close();
  }
}

function spawnError(err: NodeJS.ErrnoException, bin: string): ClaudeCliError {
  if (err.code === "ENOENT") {
    return new ClaudeCliError(
      "not_installed",
      `Claude Code CLI not found ("${bin}"). Install it with: npm install -g @anthropic-ai/claude-code`,
      { cause: err },
    );
  }
  return new ClaudeCliError("exit", `Could not start the Claude CLI: ${err.message}`, { cause: err });
}

function parseLine(line: string): Event | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Event) : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(r: Event): string {
  if (typeof r.result === "string" && r.result) return r.result;
  if (Array.isArray(r.errors) && r.errors.length) return r.errors.map(String).join("; ");
  return String(r.subtype ?? "unknown error");
}

function readRateLimit(raw: unknown): RateLimit | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const info = raw as Record<string, unknown>;
  if (typeof info.status !== "string") return undefined;
  return {
    status: info.status,
    resetsAt: typeof info.resetsAt === "number" ? new Date(info.resetsAt * 1000) : undefined,
    window: typeof info.rateLimitType === "string" ? info.rateLimitType : undefined,
  };
}

function readUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  };
}

/**
 * modelUsage can list a side model (a small Haiku call) next to the one that
 * answered: prefer the model that was asked for, else the last one listed.
 */
export function answeringModel(modelUsage: unknown, requested: string | undefined): string | undefined {
  if (typeof modelUsage !== "object" || modelUsage === null) return undefined;
  const models = Object.keys(modelUsage);
  const wanted = (requested || DEFAULT_MODEL).toLowerCase();
  return models.find((m) => m.toLowerCase().includes(wanted)) ?? models.at(-1);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function preview(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}
