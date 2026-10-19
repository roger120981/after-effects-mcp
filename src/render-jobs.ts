// Pure helpers for asynchronous renders through aerender (no spawning here).

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

export function parseAerenderProgress(logText: string): AerenderProgress {
  const lines = logText.split(/\r?\n/).filter((l) => l.trim() !== "");
  const lastLine = lines.length ? lines[lines.length - 1] : "";
  let state: AerenderProgress["state"] = "running";
  if (lines.some((l) => /^\s*aerender ERROR/.test(l) || l.includes("ERROR:"))) {
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

interface Emitter {
  on(event: string, listener: (...args: any[]) => void): unknown;
}
export interface ChildLike extends Emitter {
  stdout?: Emitter | null;
  stderr?: Emitter | null;
}

export interface JobStatus {
  jobId: string;
  state: "running" | "done" | "error";
  exitCode?: number;
  framesRendered?: number;
  lastLine: string;
  elapsedSeconds: number;
  outputPath?: string;
  tail: string;
}

interface Job {
  log: string;
  exitCode?: number;
  failed: boolean;
  startedAt: number;
  finishedAt?: number;
  outputPath?: string;
}

export class JobRegistry {
  private jobs = new Map<string, Job>();
  private now: () => number;
  private tailLines: number;
  private maxLogChars: number;
  private maxJobs: number;

  constructor(opts: { now?: () => number; tailLines?: number; maxLogChars?: number; maxJobs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.tailLines = opts.tailLines ?? 20;
    // aerender prints one PROGRESS line per frame: keep only a rolling window of the log.
    this.maxLogChars = opts.maxLogChars ?? 64 * 1024;
    this.maxJobs = opts.maxJobs ?? 50;
  }

  /** Current length of the retained log (for diagnostics and tests). */
  logLength(id: string): number | undefined {
    return this.jobs.get(id)?.log.length;
  }

  private evictFinished(): void {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.maxJobs) break;
      if (job.finishedAt !== undefined) this.jobs.delete(id);
    }
  }

  createJob(id: string, child: ChildLike, meta: { outputPath?: string } = {}): void {
    const job: Job = { log: "", failed: false, startedAt: this.now(), outputPath: meta.outputPath };
    this.jobs.set(id, job);
    this.evictFinished();
    const append = (chunk: unknown) => {
      job.log += String(chunk);
      if (job.log.length > this.maxLogChars) {
        const cut = job.log.slice(-this.maxLogChars);
        // drop the partial first line so parsing never sees a truncated line
        const nl = cut.indexOf("\n");
        job.log = nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err: Error) => {
      job.log += `\nspawn error: ${err.message}\n`;
      job.failed = true;
      job.finishedAt ??= this.now();
    });
    child.on("close", (code: number | null) => {
      job.exitCode = code ?? -1;
      job.finishedAt ??= this.now();
    });
  }

  status(id: string): JobStatus | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const progress = parseAerenderProgress(job.log);
    let state = progress.state;
    if (job.failed) state = "error";
    else if (job.exitCode !== undefined) state = job.exitCode === 0 ? "done" : "error";
    const end = job.finishedAt ?? this.now();
    const lines = job.log.split(/\r?\n/).filter((l) => l !== "");
    return {
      jobId: id,
      state,
      exitCode: job.exitCode,
      framesRendered: progress.framesRendered,
      lastLine: progress.lastLine,
      elapsedSeconds: Math.round((end - job.startedAt) / 1000),
      outputPath: job.outputPath,
      tail: lines.slice(-this.tailLines).join("\n"),
    };
  }
}
