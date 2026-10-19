import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  resolveAerenderPath,
  buildAerenderArgs,
  parseAerenderProgress,
  JobRegistry,
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
  assert.equal(parseAerenderProgress("something ERROR: bad\n").state, "error");
  assert.deepEqual(parseAerenderProgress(""), { state: "running", lastLine: "" });
});

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test("JobRegistry tracks output and exit code", () => {
  let t = 1000;
  const reg = new JobRegistry({ now: () => t });
  const child = fakeChild();
  reg.createJob("j1", child, { outputPath: "o.mp4" });
  child.stdout.emit("data", Buffer.from("PROGRESS:  0;00;00;05 (6): 0 Seconds\n"));
  let s = reg.status("j1")!;
  assert.equal(s.state, "running");
  assert.equal(s.framesRendered, 6);
  assert.equal(s.exitCode, undefined);
  t = 4000;
  child.stderr.emit("data", "warn\n");
  child.emit("close", 0);
  s = reg.status("j1")!;
  assert.equal(s.state, "done");
  assert.equal(s.exitCode, 0);
  assert.equal(s.elapsedSeconds, 3);
  assert.equal(s.outputPath, "o.mp4");
  assert.match(s.tail, /warn/);
});

test("JobRegistry reports non-zero exit and spawn errors as error; unknown id is undefined", () => {
  const reg = new JobRegistry();
  const c1 = fakeChild();
  reg.createJob("a", c1);
  c1.emit("close", 1);
  assert.equal(reg.status("a")!.state, "error");
  const c2 = fakeChild();
  reg.createJob("b", c2);
  c2.emit("error", new Error("ENOENT"));
  const s = reg.status("b")!;
  assert.equal(s.state, "error");
  assert.match(s.tail, /ENOENT/);
  assert.equal(reg.status("zzz"), undefined);
});

test("JobRegistry tail keeps only the last lines", () => {
  const reg = new JobRegistry({ tailLines: 3 });
  const c = fakeChild();
  reg.createJob("t", c);
  c.stdout.emit("data", "1\n2\n3\n4\n5\n");
  assert.equal(reg.status("t")!.tail, "3\n4\n5");
});

test("JobRegistry keeps the log bounded but still reports the latest progress", () => {
  const reg = new JobRegistry({ maxLogChars: 200 });
  const child = fakeChild();
  reg.createJob("big", child);
  for (let i = 1; i <= 500; i++) child.stdout.emit("data", `PROGRESS:  0;00;00;01 (${i}): 0 Seconds\n`);
  const s = reg.status("big")!;
  assert.equal(s.framesRendered, 500);
  assert.ok(reg.logLength("big")! <= 200);
});

test("JobRegistry evicts the oldest finished jobs beyond maxJobs", () => {
  const reg = new JobRegistry({ maxJobs: 2 });
  const a = fakeChild(), b = fakeChild(), c = fakeChild();
  reg.createJob("a", a); a.emit("close", 0);
  reg.createJob("b", b); b.emit("close", 0);
  reg.createJob("c", c);
  assert.equal(reg.status("a"), undefined);
  assert.ok(reg.status("b"));
  assert.ok(reg.status("c"));
});
