import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type JobEvent, RunLog, type ScenarioName } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import type { EventBus } from "./events.js";

const MAX_EVENTS_PER_RUN = 500;
const KEEP_RUNS = 30;

interface Run {
  runId: string;
  scenario?: ScenarioName;
  startedAt?: string;
  events: JobEvent[];
}

/**
 * Every event that carries a runId, grouped by run, for replays and demo-check. Runs are also
 * written to DATA_DIR/runs, so the last real run survives a restart; writing is best effort.
 */
export class RunStore {
  private readonly runs = new Map<string, Run>();
  private latestRunId: string | undefined;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private warned = false;

  constructor(
    bus: EventBus,
    private readonly dir: string | null,
    private readonly log: Logger,
  ) {
    this.load();
    bus.subscribe((event) => this.add(event));
  }

  private add(event: JobEvent): void {
    if (!event.runId || event.dev) return;
    let run = this.runs.get(event.runId);
    if (!run) {
      run = { runId: event.runId, events: [] };
      this.runs.set(event.runId, run);
      while (this.runs.size > KEEP_RUNS) {
        const [oldest] = this.runs.keys();
        if (oldest === undefined) break;
        this.runs.delete(oldest);
        this.remove(oldest);
      }
    }
    // A run's outcome is always kept, even past the cap: a replay must show how it ended.
    const terminal = event.type === "run.completed" || event.type === "run.failed";
    if (run.events.length < MAX_EVENTS_PER_RUN || terminal) run.events.push(event);
    if (event.type === "run.started") {
      run.scenario = event.data.scenario;
      run.startedAt = event.ts;
      this.latestRunId = event.runId;
    }
    this.persistSoon(run);
  }

  get(runId: string): RunLog | undefined {
    const run = this.runs.get(runId);
    return run ? { ...run, events: [...run.events] } : undefined;
  }

  latest(): RunLog | undefined {
    return this.latestRunId ? this.get(this.latestRunId) : undefined;
  }

  private persistSoon(run: Run): void {
    if (!this.dir || this.pending.has(run.runId)) return;
    this.pending.set(
      run.runId,
      setTimeout(() => {
        this.pending.delete(run.runId);
        try {
          const dir = join(this.dir as string, "runs");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${run.runId}.json`), JSON.stringify(run));
        } catch (err) {
          if (!this.warned)
            this.log.warn({ err }, "could not save a run log; keeping it in memory");
          this.warned = true;
        }
      }, 500),
    );
  }

  /** Deletes a run's file once memory no longer keeps it, so files follow the same limit. */
  private remove(runId: string): void {
    const timer = this.pending.get(runId);
    if (timer) clearTimeout(timer);
    this.pending.delete(runId);
    if (!this.dir) return;
    try {
      rmSync(join(this.dir, "runs", `${runId}.json`), { force: true });
    } catch {
      // Best effort, like writing.
    }
  }

  private load(): void {
    if (!this.dir) return;
    const dir = join(this.dir, "runs");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return; // No saved runs yet.
    }
    // One unreadable file (say, cut short by a crash mid-write) costs only itself.
    const runs = files
      .flatMap((f) => {
        try {
          const parsed = RunLog.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
          return parsed.success ? [parsed.data] : [];
        } catch {
          this.log.warn({ file: f }, "skipping an unreadable run log");
          return [];
        }
      })
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    for (const old of runs.slice(0, -KEEP_RUNS)) this.remove(old.runId);
    for (const run of runs.slice(-KEEP_RUNS)) {
      this.runs.set(run.runId, { ...run, events: run.events });
      if (run.startedAt) this.latestRunId = run.runId;
    }
  }
}
