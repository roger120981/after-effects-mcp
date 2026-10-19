// Helpers for asynchronous renders through aerender (no spawning here).
// Job records and logs live on disk so they survive MCP server restarts.
import * as fs from "node:fs";
import * as path from "node:path";

export interface ResolveAerenderOptions {
  env: Record<string, string | undefined>;
  platform: string;
  exists: (path: string) => boolean;
}

const YEARS = [2026, 2025, 2024, 2023, 2022, 2021];

export function resolveAerenderPath(opts: ResolveAerenderOptions): string | undefined {
  const override = opts.env.AE_RENDER_EXE;
  if (override && opts.exists(override)) return override;
  let candidates: string[] = [];
  if (opts.platform === "win32") {
    candidates = YEARS.map(
      (y) => `C:\\Program Files\\Adobe\\Adobe After Effects ${y}\\Support Files\\aerender.exe`
    );
  } else if (opts.platform === "darwin") {
    candidates = YEARS.map((y) => `/Applications/Adobe After Effects ${y}/aerender`);
  }
  return candidates.find((c) => opts.exists(c));
}

export interface AerenderArgsInput {
  projectPath: string;
  compName: string;
  outputPath: string;
  renderSettings?: string;
  outputModule?: string;
}

function requireText(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required and must not be empty`);
  }
  return value;
}

export function buildAerenderArgs(input: AerenderArgsInput): string[] {
  const args = [
    "-project", requireText(input.projectPath, "projectPath"),
    "-comp", requireText(input.compName, "compName"),
    "-output", requireText(input.outputPath, "outputPath"),
  ];
  if (input.renderSettings) args.push("-RStemplate", input.renderSettings);
  if (input.outputModule) args.push("-OMtemplate", input.outputModule);
  return args;
}

export interface AerenderProgress {
  state: "running" | "done" | "error";
  lastLine: string;
  framesRendered?: number;
}

// Only lines that START with an error marker count; "ERROR:" inside a path or message does not.
function isErrorLine(line: string): boolean {
  return /^(aerender ERROR|ERROR:|Error:)/.test(line.trim());
}

export function parseAerenderProgress(logText: string): AerenderProgress {
  const lines = logText.split(/\r?\n/).filter((l) => l.trim() !== "");
  const lastLine = lines.length ? lines[lines.length - 1] : "";
  let state: AerenderProgress["state"] = "running";
  if (lines.some(isErrorLine)) {
    state = "error";
  } else if (/Finished composition|Total Time Elapsed/.test(logText)) {
    state = "done";
  }
  const result: AerenderProgress = { state, lastLine };
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/PROGRESS:/.test(lines[i])) {
      const m = lines[i].match(/\((\d+)\)/);
      if (m) {
        result.framesRendered = Number(m[1]);
        break;
      }
    }
  }
  return result;
}

export type JobState = "running" | "done" | "error" | "unknown";

export interface InferJobStateInput {
  exitCode?: number;
  alive: boolean;
  logTail: string;
}

export function inferJobState(input: InferJobStateInput): {
  state: JobState;
  framesRendered?: number;
  lastLine: string;
} {
  const progress = parseAerenderProgress(input.logTail);
  const base = { framesRendered: progress.framesRendered, lastLine: progress.lastLine };
  if (input.exitCode !== undefined) return { ...base, state: input.exitCode === 0 ? "done" : "error" };
  if (input.alive) return { ...base, state: "running" };
  // Process gone and no exit code recorded (server restarted meanwhile): trust the log.
  if (progress.state === "error") return { ...base, state: "error" };
  if (progress.state === "done") return { ...base, state: "done" };
  return { ...base, state: "unknown" };
}

export const DEFAULT_TAIL_BYTES = 64 * 1024;

/** Read at most the last `maxBytes` of a file ("" if unreadable). Drops a partial first line. */
export function readLogTail(file: string, maxBytes = DEFAULT_TAIL_BYTES): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buf.subarray(0, read).toString("utf8");
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    return nl >= 0 && nl < text.length - 1 ? text.slice(nl + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Default liveness check: signal 0 probes the pid without killing it. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface RenderJobRecord {
  jobId: string;
  pid?: number;
  aerender: string;
  args: string[];
  projectPath: string;
  compName: string;
  outputPath: string;
  logPath: string;
  startedAt: string;
  exitCode?: number;
  finishedAt?: string;
}

export interface JobStatus {
  jobId: string;
  state: JobState;
  exitCode?: number;
  framesRendered?: number;
  lastLine: string;
  elapsedSeconds: number;
  outputPath?: string;
  logPath: string;
  tail: string;
}

export interface RenderJobStoreOptions {
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  tailBytes?: number;
  tailLines?: number;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export class RenderJobStore {
  readonly dir: string;
  private now: () => number;
  private isAlive: (pid: number) => boolean;
  private tailBytes: number;
  private tailLines: number;

  constructor(dir: string, opts: RenderJobStoreOptions = {}) {
    this.dir = dir;
    this.now = opts.now ?? Date.now;
    this.isAlive = opts.isAlive ?? isProcessAlive;
    this.tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
    this.tailLines = opts.tailLines ?? 20;
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private assertId(id: string): void {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid jobId: ${id}`);
  }

  recordPathFor(id: string): string {
    this.assertId(id);
    return path.join(this.dir, `${id}.json`);
  }

  logPathFor(id: string): string {
    this.assertId(id);
    return path.join(this.dir, `${id}.log`);
  }

  save(record: RenderJobRecord): void {
    this.ensureDir();
    const file = this.recordPathFor(record.jobId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
  }

  load(id: string): RenderJobRecord | undefined {
    if (!SAFE_ID.test(id)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(this.recordPathFor(id), "utf8")) as RenderJobRecord;
    } catch {
      return undefined;
    }
  }

  update(id: string, patch: Partial<RenderJobRecord>): void {
    const current = this.load(id);
    if (current) this.save({ ...current, ...patch, jobId: id });
  }

  appendLog(id: string, text: string): void {
    try {
      fs.appendFileSync(this.logPathFor(id), text);
    } catch { /* best effort */ }
  }

  statusOf(record: RenderJobRecord): JobStatus {
    const logTail = readLogTail(record.logPath || this.logPathFor(record.jobId), this.tailBytes);
    const alive = record.pid !== undefined && record.exitCode === undefined ? this.isAlive(record.pid) : false;
    const inferred = inferJobState({ exitCode: record.exitCode, alive, logTail });
    const started = Date.parse(record.startedAt);
    const finished = record.finishedAt ? Date.parse(record.finishedAt) : undefined;
    const end = inferred.state === "running" || finished === undefined ? this.now() : finished;
    const lines = logTail.split(/\r?\n/).filter((l) => l.trim() !== "");
    return {
      jobId: record.jobId,
      state: inferred.state,
      exitCode: record.exitCode,
      framesRendered: inferred.framesRendered,
      lastLine: inferred.lastLine,
      elapsedSeconds: Math.max(0, Math.round((end - started) / 1000)),
      outputPath: record.outputPath,
      logPath: record.logPath,
      tail: lines.slice(-this.tailLines).join("\n"),
    };
  }

  status(id: string): JobStatus | undefined {
    const record = this.load(id);
    return record ? this.statusOf(record) : undefined;
  }

  /** Newest first. Corrupt or unreadable records are skipped. */
  list(limit = 20): JobStatus[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const records: RenderJobRecord[] = [];
    for (const name of names) {
      const r = this.load(name.slice(0, -".json".length));
      if (r && typeof r.startedAt === "string") records.push(r);
    }
    records.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return records.slice(0, Math.max(0, limit)).map((r) => this.statusOf(r));
  }

  /** Delete records (and logs) started more than maxAgeMs ago that are not running. */
  prune(maxAgeMs: number): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      const id = name.slice(0, -".json".length);
      const r = this.load(id);
      if (!r) continue;
      if (this.now() - Date.parse(r.startedAt) <= maxAgeMs) continue;
      if (r.exitCode === undefined && r.pid !== undefined && this.isAlive(r.pid)) continue;
      for (const f of [this.recordPathFor(id), r.logPath || this.logPathFor(id)]) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
    }
  }
}
