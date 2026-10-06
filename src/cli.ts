import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Removed from the CLI's environment on every call. With any of the auth or
 * provider variables set, the CLI bills that API key or cloud account instead
 * of your Claude login. CLAUDECODE is set inside a Claude Code session and makes
 * a nested `claude` refuse to start.
 */
export const STRIPPED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDECODE",
] as const;

export const DEFAULT_MODEL = "sonnet";
export const DEFAULT_SYSTEM = "You are a helpful assistant.";
export const DEFAULT_TIMEOUT_MS = 180_000;

export type Effort = "low" | "medium" | "high";

export interface RunOptions {
  /** The user message. Sent on stdin, so any length is fine. */
  prompt: string;
  /** Replaces Claude Code's own system prompt. */
  system?: string;
  /** An alias ("haiku", "sonnet", "opus") or a full model id. */
  model?: string;
  /** JSON Schema; the reply comes back parsed in `data`. */
  jsonSchema?: object;
  effort?: Effort;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Path to the CLI, if `claude` is not on PATH. */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces child_process.spawn. */
  spawnImpl?: SpawnLike;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface RunResult<T = unknown> {
  /** The reply text ("" when a jsonSchema was given; read `data`). */
  text: string;
  /** The parsed reply when a jsonSchema was given. */
  data: T | undefined;
  /** What the call would have cost on the API. Not billed: it counts toward your plan's usage limits. */
  apiCostUsd: number;
  /** Wall-clock time including CLI startup. */
  durationMs: number;
  /** The model that answered, e.g. "claude-haiku-4-5-20251001". */
  model: string | undefined;
  usage: Usage;
}

export type ErrorKind = "not_installed" | "auth" | "timeout" | "aborted" | "cli_error" | "exit" | "parse";

export class ClaudeCliError extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClaudeCliError";
    this.kind = kind;
  }
}

interface Readable {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface ChildLike {
  stdout: Readable;
  stderr: Readable;
  stdin: { end(data: string): unknown; on(event: "error", listener: (err: Error) => void): unknown };
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (
  bin: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildLike;

const defaultSpawn: SpawnLike = (bin, args, options) => spawn(bin, args, options);

/** The caller's environment minus anything that would bill an API key or block the CLI. */
export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of STRIPPED_ENV) delete out[key];
  return out;
}

/** One headless turn: our system prompt, no tools, no MCP servers, no settings, nothing saved. */
export function cliArgs(options: Pick<RunOptions, "model" | "system" | "jsonSchema" | "effort">): string[] {
  const args = [
    "-p",
    "--model", options.model || DEFAULT_MODEL,
    "--system-prompt", options.system || DEFAULT_SYSTEM,
    "--tools", "",
    "--output-format", "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources", "",
  ];
  if (options.jsonSchema) args.push("--json-schema", JSON.stringify(options.jsonSchema));
  if (options.effort) args.push("--effort", options.effort);
  return args;
}

let workDir: string | undefined;

/**
 * Every call runs from one empty temp folder, so the CLI finds no CLAUDE.md,
 * project settings or project memory to add to the prompt.
 */
export function emptyWorkDir(): string {
  if (workDir) return workDir;
  const dir = mkdtempSync(join(tmpdir(), "claude-cli-evals-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  workDir = dir;
  return dir;
}

type ParsedResult<T> = Omit<RunResult<T>, "durationMs">;

/** Reads the CLI's `--output-format json` result. Throws ClaudeCliError on an error result. */
export function parseResult<T = unknown>(stdout: string): ParsedResult<T> {
  const r = findResultObject(stdout);
  if (!r) throw new ClaudeCliError("parse", `Claude CLI gave no result: ${preview(stdout) || "(no output)"}`);
  if (r.is_error === true || r.subtype !== "success") {
    const message = typeof r.result === "string" && r.result ? r.result : String(r.subtype ?? "error");
    throw new ClaudeCliError("cli_error", `Claude CLI error: ${message}`);
  }
  return {
    text: typeof r.result === "string" ? r.result : "",
    data: r.structured_output as T | undefined,
    apiCostUsd: num(r.total_cost_usd),
    model: firstKey(r.modelUsage),
    usage: readUsage(r.usage),
  };
}

/** Runs one call through the signed-in CLI. Prefer createClaude() for evals: it adds a login check, concurrency and retries. */
export function runClaude<T = unknown>(options: RunOptions): Promise<RunResult<T>> {
  const {
    prompt,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    bin = "claude",
    env = process.env,
    spawnImpl = defaultSpawn,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ClaudeCliError("aborted", "Aborted before the call started"));

    const started = Date.now();
    const child = spawnImpl(bin, cliArgs(options), {
      cwd: emptyWorkDir(),
      env: cliEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (err: Error | undefined, value?: RunResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(value as RunResult<T>);
    };
    const stop = (kind: ErrorKind, message: string) => {
      child.kill("SIGKILL");
      settle(new ClaudeCliError(kind, message));
    };
    const timer = setTimeout(() => stop("timeout", `Claude CLI timed out after ${timeoutMs} ms`), timeoutMs);
    const onAbort = () => stop("aborted", "Aborted");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => settle(spawnError(err, bin)));
    child.on("close", (code) => {
      try {
        const parsed = withData(parseResult<T>(stdout), options.jsonSchema);
        settle(undefined, { ...parsed, durationMs: Date.now() - started });
      } catch (err) {
        settle(withExitDetail(err, stderr, code));
      }
    });
    // The CLI can exit before reading stdin (bad flag, not signed in); "close" reports why.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

function withData<T>(parsed: ParsedResult<T>, jsonSchema: object | undefined): ParsedResult<T> {
  if (!jsonSchema || parsed.data !== undefined) return parsed;
  try {
    return { ...parsed, data: JSON.parse(parsed.text) as T };
  } catch {
    throw new ClaudeCliError("parse", `Asked for JSON but got: ${preview(parsed.text) || "(empty reply)"}`);
  }
}

function withExitDetail(err: unknown, stderr: string, code: number | null): Error {
  if (!(err instanceof ClaudeCliError) || err.kind !== "parse") return err as Error;
  if (!stderr.trim() && code === 0) return err;
  return new ClaudeCliError("exit", `Claude CLI failed (exit ${code}): ${preview(stderr) || err.message}`);
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

function findResultObject(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const whole = tryJson(trimmed);
  if (isResult(whole)) return whole;
  // A warning printed before the JSON: take the last result line.
  for (const line of trimmed.split("\n").reverse()) {
    const candidate = tryJson(line.trim());
    if (isResult(candidate)) return candidate;
  }
  return undefined;
}

function isResult(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "result";
}

function tryJson(text: string): unknown {
  if (!text.startsWith("{")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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

function firstKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.keys(value)[0];
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function preview(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}
