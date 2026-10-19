// Pure helpers for the MCP <-> After Effects bridge protocol.
// No side effects at import time; everything is injectable for testing.
import * as path from "node:path";

export interface BridgeCommand {
  command: string;
  args: Record<string, unknown>;
  commandId: string;
  timestamp: string;
  status: "pending";
}

export function createCommandId(): string {
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return Date.now().toString(36) + rand;
}

export function buildCommand(
  command: string,
  args: Record<string, unknown>,
  commandId: string,
  now: Date = new Date(),
): BridgeCommand {
  return { command, args, commandId, timestamp: now.toISOString(), status: "pending" };
}

export function matchesCommand(resultText: string, commandId: string): { matched: boolean; parsed?: any } {
  if (!resultText) return { matched: false };
  try {
    const parsed = JSON.parse(resultText);
    if (parsed && typeof parsed === "object" && parsed._commandId === commandId) {
      return { matched: true, parsed };
    }
  } catch {
    // not (yet) valid JSON
  }
  return { matched: false };
}

export interface ResolveBridgeDirOptions {
  env: Record<string, string | undefined>;
  platform: string;
  homedir: string;
}

// Precedence: AE_MCP_BRIDGE_DIR > win32 %APPDATA% (local, not OneDrive-synced) > homedir/Documents
export function resolveBridgeDir(opts: ResolveBridgeDirOptions): string {
  const override = opts.env.AE_MCP_BRIDGE_DIR;
  if (override) return override;
  const p = opts.platform === "win32" ? path.win32 : path.posix;
  if (opts.platform === "win32") {
    const appData = opts.env.APPDATA;
    if (appData) return p.join(appData, "ae-mcp-bridge");
  }
  return p.join(opts.homedir, "Documents", "ae-mcp-bridge");
}

export function clampTimeout(
  ms: number | undefined,
  def: number = 60000,
  max: number = 600000,
  min: number = 1000,
): number {
  if (ms === undefined || !Number.isFinite(ms)) return def;
  return Math.min(max, Math.max(min, ms));
}

export interface WaitResult {
  timedOut: boolean;
  parsed?: any;
}

// Polls readFn until a result carrying commandId appears or timeoutMs of
// (injected) sleep time has elapsed. Read errors are treated as "not ready".
export async function waitForCommandResult(
  readFn: () => string | undefined,
  commandId: string,
  timeoutMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<WaitResult> {
  let elapsed = 0;
  for (;;) {
    try {
      const text = readFn();
      if (text) {
        const m = matchesCommand(text, commandId);
        if (m.matched) return { timedOut: false, parsed: m.parsed };
      }
    } catch {
      // transient read error (file locked while AE writes); keep polling
    }
    if (elapsed >= timeoutMs) return { timedOut: true };
    const step = Math.min(pollMs, timeoutMs - elapsed);
    await sleep(step);
    elapsed += step;
  }
}

/**
 * Returns the command file content with status "cancelled" when it still holds
 * the given pending command, so the AE bridge never runs it after the caller gave up.
 * Returns undefined when there is nothing to cancel.
 */
export function cancelPendingCommand(commandText: string, commandId: string): string | undefined {
  try {
    const parsed = JSON.parse(commandText);
    if (parsed && parsed.commandId === commandId && parsed.status === "pending") {
      return JSON.stringify({ ...parsed, status: "cancelled" }, null, 2);
    }
  } catch {
    // unreadable command file: nothing to cancel
  }
  return undefined;
}
