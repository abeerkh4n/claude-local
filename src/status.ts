import { spawnSync } from "node:child_process";
import { ClaudeCliError, cliEnv } from "./cli.js";

export interface ClaudeStatus {
  installed: boolean;
  version?: string;
  loggedIn: boolean;
  /** "claude.ai" means a Claude subscription (Pro, Max, Team, Enterprise). */
  authMethod?: string;
  /** e.g. "pro" or "max". */
  subscriptionType?: string;
}

export type SpawnSyncLike = (
  bin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; encoding: "utf8"; timeout: number },
) => { stdout: string | null; error?: Error };

const defaultSpawnSync: SpawnSyncLike = (bin, args, options) => spawnSync(bin, args, options);

/** Asks the CLI whether it is installed and how it is signed in. Never throws. */
export function claudeStatus(
  options: { bin?: string; env?: NodeJS.ProcessEnv; spawnSyncImpl?: SpawnSyncLike } = {},
): ClaudeStatus {
  const { bin = "claude", env = process.env, spawnSyncImpl = defaultSpawnSync } = options;
  const run = (args: string[]) => spawnSyncImpl(bin, args, { env: cliEnv(env), encoding: "utf8", timeout: 20_000 });

  const version = run(["--version"]);
  if (version.error) return { installed: false, loggedIn: false };

  const auth = parseJson(run(["auth", "status"]).stdout);
  return {
    installed: true,
    version: version.stdout?.trim().split(/\s+/)[0] || undefined,
    loggedIn: auth?.loggedIn === true,
    authMethod: str(auth?.authMethod),
    subscriptionType: str(auth?.subscriptionType),
  };
}

export function isSubscription(status: ClaudeStatus): boolean {
  return status.loggedIn && status.authMethod === "claude.ai";
}

/** Throws a ClaudeCliError that says how to fix it unless the CLI is signed in with a Claude subscription. */
export function assertSubscription(status: ClaudeStatus = claudeStatus()): ClaudeStatus {
  if (!status.installed) {
    throw new ClaudeCliError(
      "not_installed",
      "Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code",
    );
  }
  if (!status.loggedIn) {
    throw new ClaudeCliError("auth", "Claude Code is not signed in. Run `claude auth login` and sign in with your Claude account.");
  }
  if (!isSubscription(status)) {
    throw new ClaudeCliError(
      "auth",
      `Claude Code is signed in with "${status.authMethod ?? "unknown"}", not a Claude subscription, so calls would be billed to the API. ` +
        "Run `claude auth logout`, then `claude auth login` with your Claude account. " +
        "To use this login anyway, pass requireSubscription: false.",
    );
  }
  return status;
}

function parseJson(text: string | null): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
