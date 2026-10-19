import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCommandId,
  buildCommand,
  matchesCommand,
  resolveBridgeDir,
  clampTimeout,
  waitForCommandResult,
} from "./bridge-protocol.ts";

test("createCommandId returns unique non-empty ids", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 500; i++) ids.add(createCommandId());
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[a-z0-9]+$/);
});

test("buildCommand produces a pending command with id and ISO timestamp", () => {
  const now = new Date("2026-10-19T12:00:00.000Z");
  const cmd = buildCommand("runExtendScript", { code: "return 1;" }, "abc123", now);
  assert.deepEqual(cmd, {
    command: "runExtendScript",
    args: { code: "return 1;" },
    commandId: "abc123",
    timestamp: "2026-10-19T12:00:00.000Z",
    status: "pending",
  });
});

test("matchesCommand matches only on equal _commandId", () => {
  const ok = matchesCommand(JSON.stringify({ _commandId: "x1", status: "success" }), "x1");
  assert.equal(ok.matched, true);
  assert.equal(ok.parsed.status, "success");
  assert.equal(matchesCommand(JSON.stringify({ _commandId: "other" }), "x1").matched, false);
  assert.equal(matchesCommand(JSON.stringify({ status: "waiting" }), "x1").matched, false);
});

test("matchesCommand tolerates invalid or empty JSON", () => {
  assert.equal(matchesCommand("", "x1").matched, false);
  assert.equal(matchesCommand("{not json", "x1").matched, false);
  assert.equal(matchesCommand("null", "x1").matched, false);
});

test("resolveBridgeDir: env override wins", () => {
  const dir = resolveBridgeDir({
    env: { AE_MCP_BRIDGE_DIR: "D:\\bridge" },
    platform: "win32",
    homedir: "C:\\Users\\admin",
    queryWindowsDocuments: () => "C:\\Users\\admin\\OneDrive\\Documents",
  });
  assert.equal(dir, "D:\\bridge");
});

test("resolveBridgeDir: empty env is ignored; win32 uses known Documents folder", () => {
  const dir = resolveBridgeDir({
    env: { AE_MCP_BRIDGE_DIR: "" },
    platform: "win32",
    homedir: "C:\\Users\\admin",
    queryWindowsDocuments: () => "C:\\Users\\admin\\OneDrive\\Documents",
  });
  assert.equal(dir, "C:\\Users\\admin\\OneDrive\\Documents\\ae-mcp-bridge");
});

test("resolveBridgeDir: win32 falls back to homedir when query yields nothing", () => {
  for (const q of [() => undefined, () => ""]) {
    const dir = resolveBridgeDir({
      env: {},
      platform: "win32",
      homedir: "C:\\Users\\admin",
      queryWindowsDocuments: q,
    });
    assert.equal(dir, "C:\\Users\\admin\\Documents\\ae-mcp-bridge");
  }
});

test("resolveBridgeDir: non-windows ignores the Windows query", () => {
  let called = false;
  const dir = resolveBridgeDir({
    env: {},
    platform: "darwin",
    homedir: "/Users/a",
    queryWindowsDocuments: () => {
      called = true;
      return "X";
    },
  });
  assert.equal(dir, "/Users/a/Documents/ae-mcp-bridge");
  assert.equal(called, false);
});

test("clampTimeout applies default, min and max", () => {
  assert.equal(clampTimeout(undefined), 60000);
  assert.equal(clampTimeout(NaN), 60000);
  assert.equal(clampTimeout(10), 1000);
  assert.equal(clampTimeout(5000), 5000);
  assert.equal(clampTimeout(9_999_999), 600000);
});

test("waitForCommandResult returns the matching result, skipping stale ones", async () => {
  const reads = [
    undefined,
    JSON.stringify({ status: "waiting" }),
    JSON.stringify({ _commandId: "old", status: "success" }),
    JSON.stringify({ _commandId: "me", status: "success", result: 7 }),
  ];
  let i = 0;
  const out = await waitForCommandResult(() => reads[Math.min(i++, reads.length - 1)], "me", 10_000, 200, async () => {});
  assert.equal(out.timedOut, false);
  assert.equal(out.parsed.result, 7);
  assert.equal(i, 4);
});

test("waitForCommandResult times out when only mismatched results appear", async () => {
  let slept = 0;
  const out = await waitForCommandResult(
    () => JSON.stringify({ _commandId: "other" }),
    "me",
    1000,
    200,
    async (ms) => {
      slept += ms;
    },
  );
  assert.equal(out.timedOut, true);
  assert.equal(out.parsed, undefined);
  assert.equal(slept, 1000);
});

test("waitForCommandResult survives read errors", async () => {
  let n = 0;
  const out = await waitForCommandResult(
    () => {
      if (n++ < 2) throw new Error("EBUSY");
      return JSON.stringify({ _commandId: "me" });
    },
    "me",
    5000,
    200,
    async () => {},
  );
  assert.equal(out.timedOut, false);
});
