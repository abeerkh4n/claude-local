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
export const DEFAULT_TIMEOUT_MS = 300_000;

export type Effort = "low" | "medium" | "high";

export interface ModelOptions {
  /** An alias ("haiku", "sonnet", "opus") or a full model id. Default "sonnet". */
  model?: string;
  /** Replaces Claude Code's own system prompt. */
  system?: string;
  /** JSON Schema; the reply comes back parsed in `data`. */
  jsonSchema?: object;
  /** How hard the model thinks. Leave unset for the model's default. */
  effort?: Effort;
}

export interface ProcessOptions {
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

export interface RateLimit {
  /** "allowed", "allowed_warning" or "rejected". */
  status: string;
  /** When the current usage window resets. */
  resetsAt: Date | undefined;
  /** e.g. "five_hour". */
  window: string | undefined;
}

export interface RunResult<T = unknown> {
  /** The reply text. */
  text: string;
  /** The parsed reply when a jsonSchema was given. */
  data: T | undefined;
  /** What this call would have cost on the API. Not billed: it counts toward your plan's usage limits. */
  apiCostUsd: number;
  /** Wall-clock time, including CLI startup for a new process. */
  durationMs: number;
  /** The model that answered, e.g. "claude-haiku-4-5-20251001". */
  model: string | undefined;
  usage: Usage;
  /** The plan's usage window as of this call, when the CLI reported it. */
  rateLimit: RateLimit | undefined;
}

export type ErrorKind =
  | "not_installed"
  | "auth"
  | "usage_limit"
  | "timeout"
  | "aborted"
  | "cli_error"
  | "exit"
  | "parse"
  | "closed";

export class ClaudeCliError extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClaudeCliError";
    this.kind = kind;
  }
}

interface Pipe {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  ref?(): unknown;
  unref?(): unknown;
}

export interface ChildLike {
  stdout: Pipe;
  stderr: Pipe;
  stdin: {
    write(data: string): unknown;
    end(): unknown;
    on(event: "error", listener: (err: Error) => void): unknown;
    ref?(): unknown;
    unref?(): unknown;
  };
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  ref?(): unknown;
  unref?(): unknown;
}

export type SpawnLike = (
  bin: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildLike;

/** The caller's environment minus anything that would bill an API key or block the CLI. */
export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of STRIPPED_ENV) delete out[key];
  return out;
}

/**
 * A headless session that reads user messages as JSON lines on stdin and writes
 * events as JSON lines on stdout: our system prompt, no tools, no MCP servers,
 * no settings, nothing saved.
 */
export function cliArgs(options: ModelOptions & { partial?: boolean }): string[] {
  const args = [
    "-p",
    "--model", options.model || DEFAULT_MODEL,
    "--system-prompt", options.system || DEFAULT_SYSTEM,
    "--tools", "",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources", "",
  ];
  if (options.partial) args.push("--include-partial-messages");
  if (options.jsonSchema) args.push("--json-schema", JSON.stringify(options.jsonSchema));
  if (options.effort) args.push("--effort", options.effort);
  return args;
}
