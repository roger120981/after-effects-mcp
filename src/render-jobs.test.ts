import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAerenderPath,
  buildAerenderArgs,
  parseAerenderProgress,
  inferJobState,
  readLogTail,
  parseTasklistCsv,
  RenderJobStore,
  type RenderJobRecord,
} from "./render-jobs.ts";

const winExe = (year: number) =>
  `C:\\Program Files\\Adobe\\Adobe After Effects ${year}\\Support Files\\aerender.exe`;

test("resolveAerenderPath prefers AE_RENDER_EXE when it exists", () => {
  const p = resolveAerenderPath({
    env: { AE_RENDER_EXE: "D:\\x\\aerender.exe" },
    platform: "win32",
    exists: (f) => f === "D:\\x\\aerender.exe",
  });
  assert.equal(p, "D:\\x\\aerender.exe");
});

test("resolveAerenderPath ignores AE_RENDER_EXE that does not exist", () => {
  const p = resolveAerenderPath({
    env: { AE_RENDER_EXE: "D:\\nope.exe" },
    platform: "win32",
    exists: (f) => f === winExe(2025),
  });
  assert.equal(p, winExe(2025));
});

test("resolveAerenderPath picks the newest installed year on win32", () => {
  const p = resolveAerenderPath({
    env: {},
    platform: "win32",
    exists: (f) => f === winExe(2024) || f === winExe(2022),
  });
  assert.equal(p, winExe(2024));
});

test("resolveAerenderPath supports darwin and returns undefined when missing", () => {
  assert.equal(
    resolveAerenderPath({
      env: {},
      platform: "darwin",
      exists: (f) => f === "/Applications/Adobe After Effects 2023/aerender",
    }),
    "/Applications/Adobe After Effects 2023/aerender"
  );
  assert.equal(resolveAerenderPath({ env: {}, platform: "linux", exists: () => true }), undefined);
  assert.equal(resolveAerenderPath({ env: {}, platform: "win32", exists: () => false }), undefined);
});

test("buildAerenderArgs builds required and optional args", () => {
  assert.deepEqual(
    buildAerenderArgs({ projectPath: "a.aep", compName: "Main", outputPath: "o.mp4" }),
    ["-project", "a.aep", "-comp", "Main", "-output", "o.mp4"]
  );
  assert.deepEqual(
    buildAerenderArgs({
      projectPath: "a.aep",
      compName: "Main",
      outputPath: "o.mp4",
      renderSettings: "Best Settings",
      outputModule: "H.264",
    }),
    ["-project", "a.aep", "-comp", "Main", "-output", "o.mp4", "-RStemplate", "Best Settings", "-OMtemplate", "H.264"]
  );
});

test("buildAerenderArgs rejects empty required fields", () => {
  assert.throws(() => buildAerenderArgs({ projectPath: "", compName: "c", outputPath: "o" }), /projectPath/);
  assert.throws(() => buildAerenderArgs({ projectPath: "p", compName: " ", outputPath: "o" }), /compName/);
  assert.throws(() => buildAerenderArgs({ projectPath: "p", compName: "c", outputPath: "" }), /outputPath/);
});

test("parseAerenderProgress detects running, frames, done and error", () => {
  const running = parseAerenderProgress("PROGRESS:  0;00;00;05 (6): 0 Seconds\nPROGRESS:  0;00;01;12 (43): 0 Seconds\n");
  assert.equal(running.state, "running");
  assert.equal(running.framesRendered, 43);
  assert.match(running.lastLine, /\(43\)/);

  assert.equal(parseAerenderProgress("PROGRESS: Finished composition \"Main\".\n").state, "done");
  assert.equal(parseAerenderProgress("PROGRESS: Total Time Elapsed: 17 Seconds\n").state, "done");
  assert.equal(parseAerenderProgress("aerender ERROR: No comp was found\n").state, "error");
  assert.equal(parseAerenderProgress("  ERROR: bad\n").state, "error");
  assert.equal(parseAerenderProgress("Error: bad\n").state, "error");
  assert.equal(parseAerenderProgress("something ERROR: bad\n").state, "running");
  assert.deepEqual(parseAerenderProgress(""), { state: "running", lastLine: "" });
});

test("parseAerenderProgress does not flag ERROR: in the middle of a line", () => {
  const p = parseAerenderProgress("Writing to C:\\renders\\ERROR:test.mov\nPROGRESS:  0;00;00;05 (6): 0 Seconds\n");
  assert.equal(p.state, "running");
  assert.equal(p.framesRendered, 6);
});

test("inferJobState uses the exit code first", () => {
  assert.equal(inferJobState({ exitCode: 0, alive: true, logTail: "" }).state, "done");
  assert.equal(inferJobState({ exitCode: 1, alive: false, logTail: "Finished composition" }).state, "error");
});

test("inferJobState reports running while the process is alive", () => {
  const r = inferJobState({ alive: true, logTail: "PROGRESS:  0;00;00;05 (6): 0 Seconds\n" });
  assert.equal(r.state, "running");
  assert.equal(r.framesRendered, 6);
});

test("inferJobState infers the outcome from the log when the process is gone", () => {
  assert.equal(inferJobState({ alive: false, logTail: "PROGRESS: Total Time Elapsed: 3 Seconds\n" }).state, "done");
  assert.equal(inferJobState({ alive: false, logTail: "Finished composition \"Main\"." }).state, "done");
  assert.equal(inferJobState({ alive: false, logTail: "aerender ERROR: nope\n" }).state, "error");
  assert.equal(inferJobState({ alive: false, logTail: "PROGRESS: (3)\n" }).state, "unknown");
  assert.equal(inferJobState({ alive: false, logTail: "" }).state, "unknown");
});

test("readLogTail reads only the last bytes of a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "rj-"));
  try {
    const f = join(dir, "a.log");
    writeFileSync(f, "x".repeat(1000) + "\nlast line\n");
    const t = readLogTail(f, 50);
    assert.ok(t.length <= 50);
    assert.match(t, /last line/);
    assert.equal(readLogTail(join(dir, "missing.log"), 50), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function withStore(fn: (store: RenderJobStore, dir: string, state: { now: number; alive: boolean }) => void) {
  const dir = mkdtempSync(join(tmpdir(), "rj-"));
  const state = { now: Date.parse("2026-01-10T00:00:10Z"), alive: true };
  try {
    fn(new RenderJobStore(join(dir, "render-jobs"), { now: () => state.now, isAlive: () => state.alive }), dir, state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rec(id: string, startedAt: string, extra: Partial<RenderJobRecord> = {}): RenderJobRecord {
  return {
    jobId: id, pid: 123, aerender: "aerender", args: ["-project", "a.aep"],
    projectPath: "a.aep", compName: "Main", outputPath: "o.mp4",
    logPath: "", startedAt, ...extra,
  };
}

test("RenderJobStore persists records and reports status from disk", () => {
  withStore((store, dir, state) => {
    store.ensureDir();
    const r = rec("job-1", "2026-01-10T00:00:00Z", { logPath: store.logPathFor("job-1") });
    writeFileSync(r.logPath, "PROGRESS:  0;00;00;05 (6): 0 Seconds\n");
    store.save(r);
    // a fresh store instance (server restart) still sees it
    const again = new RenderJobStore(store.dir, { now: () => state.now, isAlive: () => true });
    const s = again.status("job-1")!;
    assert.equal(s.state, "running");
    assert.equal(s.framesRendered, 6);
    assert.equal(s.elapsedSeconds, 10);
    assert.equal(s.outputPath, "o.mp4");
    assert.match(s.tail, /PROGRESS/);
    assert.equal(again.status("nope"), undefined);
  });
});

test("RenderJobStore.update records exit code and freezes elapsed time", () => {
  withStore((store, _dir, state) => {
    store.ensureDir();
    store.save(rec("j", "2026-01-10T00:00:00Z", { logPath: store.logPathFor("j") }));
    store.update("j", { exitCode: 0, finishedAt: "2026-01-10T00:00:04Z" });
    state.now += 100000;
    const s = store.status("j")!;
    assert.equal(s.state, "done");
    assert.equal(s.exitCode, 0);
    assert.equal(s.elapsedSeconds, 4);
  });
});

test("RenderJobStore reports a vanished process without exit code via the log", () => {
  withStore((store, _dir, state) => {
    store.ensureDir();
    const r = rec("j", "2026-01-10T00:00:00Z", { logPath: store.logPathFor("j") });
    writeFileSync(r.logPath, "PROGRESS: Total Time Elapsed: 3 Seconds\n");
    store.save(r);
    state.alive = false;
    assert.equal(store.status("j")!.state, "done");
  });
});

test("RenderJobStore rejects unsafe job ids", () => {
  withStore((store) => {
    assert.equal(store.status("../etc/passwd"), undefined);
    assert.throws(() => store.save(rec("../x", "2026-01-10T00:00:00Z")), /jobId/);
  });
});

test("RenderJobStore.list is newest first, limited, tolerant of corrupt files, and tails the log", () => {
  withStore((store) => {
    store.ensureDir();
    for (const [id, at] of [["a", "2026-01-10T00:00:01Z"], ["b", "2026-01-10T00:00:03Z"], ["c", "2026-01-10T00:00:02Z"]]) {
      store.save(rec(id, at, { logPath: store.logPathFor(id) }));
    }
    writeFileSync(join(store.dir, "broken.json"), "{not json");
    assert.deepEqual(store.list(10).map((s) => s.jobId), ["b", "c", "a"]);
    assert.deepEqual(store.list(2).map((s) => s.jobId), ["b", "c"]);
  });
});

test("RenderJobStore.prune removes old finished records and logs", () => {
  withStore((store, _dir, state) => {
    store.ensureDir();
    store.save(rec("old", "2025-12-01T00:00:00Z", { logPath: store.logPathFor("old"), exitCode: 0, finishedAt: "2025-12-01T00:01:00Z" }));
    writeFileSync(store.logPathFor("old"), "x");
    store.save(rec("new", "2026-01-09T00:00:00Z", { logPath: store.logPathFor("new") }));
    store.prune(7 * 24 * 3600 * 1000);
    assert.equal(store.load("old"), undefined);
    assert.equal(existsSync(store.logPathFor("old")), false);
    assert.ok(store.load("new"));
    void state;
  });
});

function flaky(failures: number, code = "EPERM") {
  let calls = 0;
  const fn = (from: string, to: string) => {
    calls++;
    if (calls <= failures) throw Object.assign(new Error("locked"), { code });
    renameSync(from, to);
  };
  return { fn, calls: () => calls };
}

test("RenderJobStore.save retries a rename that fails transiently", () => {
  const dir = mkdtempSync(join(tmpdir(), "rj-"));
  try {
    const f = flaky(2);
    const store = new RenderJobStore(join(dir, "jobs"), { renameSync: f.fn, sleep: () => {} });
    store.save(rec("j", "2026-01-10T00:00:00Z"));
    assert.equal(f.calls(), 3);
    assert.equal(store.load("j")?.jobId, "j");
    assert.equal(existsSync(`${store.recordPathFor("j")}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RenderJobStore.save falls back to a direct write when rename always fails; update never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "rj-"));
  try {
    const store = new RenderJobStore(join(dir, "jobs"), {
      renameSync: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
      sleep: () => {},
    });
    store.save(rec("j", "2026-01-10T00:00:00Z"));
    assert.equal(store.load("j")?.jobId, "j");
    assert.equal(store.update("j", { exitCode: 0 }), true);
    assert.equal(store.load("j")?.exitCode, 0);
    assert.equal(store.update("missing", { exitCode: 0 }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseTasklistCsv returns the image name for the pid", () => {
  assert.equal(parseTasklistCsv('"aerender.exe","1234","Console","1","50,000 K"\r\n', 1234), "aerender.exe");
  assert.equal(parseTasklistCsv('"chrome.exe","1234","Console","1","50,000 K"', 1234), "chrome.exe");
  assert.equal(parseTasklistCsv('"aerender.exe","99","Console","1","5 K"', 1234), undefined);
  assert.equal(parseTasklistCsv("INFO: No tasks are running which match the specified criteria.", 1234), undefined);
  assert.equal(parseTasklistCsv("", 1234), undefined);
});

test("RenderJobStore ignores tampered logPath and mismatched jobId", () => {
  withStore((store, dir) => {
    store.ensureDir();
    const outside = join(dir, "secret.log");
    writeFileSync(outside, "PROGRESS: Total Time Elapsed: 1 Seconds\n");
    store.save(rec("t", "2025-12-01T00:00:00Z", { logPath: outside, exitCode: 0 }));
    writeFileSync(store.logPathFor("t"), "own log\n");
    assert.match(store.status("t")!.tail, /own log/);
    assert.equal(store.status("t")!.logPath, store.logPathFor("t"));
    store.prune(1000);
    assert.equal(existsSync(outside), true);
    assert.equal(existsSync(store.logPathFor("t")), false);
    // record whose jobId does not match its file name is ignored
    writeFileSync(join(store.dir, "a.json"), JSON.stringify(rec("b", "2026-01-10T00:00:00Z")));
    assert.equal(store.load("a"), undefined);
    assert.deepEqual(store.list(10), []);
  });
});

test("RenderJobStore.prune removes stale orphaned .json.tmp files only", () => {
  withStore((store, _dir, state) => {
    store.ensureDir();
    const oldTmp = join(store.dir, "x.json.tmp");
    const freshTmp = join(store.dir, "y.json.tmp");
    writeFileSync(oldTmp, "{}");
    writeFileSync(freshTmp, "{}");
    state.now = Date.now();
    const old = new Date(state.now - 2 * 24 * 3600 * 1000);
    utimesSync(oldTmp, old, old);
    store.prune(7 * 24 * 3600 * 1000);
    assert.equal(existsSync(oldTmp), false);
    assert.equal(existsSync(freshTmp), true);
  });
});
