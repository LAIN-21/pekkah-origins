import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type JobEvent, RunLog, type RunScenario } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import type { EventBus } from "./events.js";

const MAX_EVENTS_PER_RUN = 500;
const KEEP_RUNS = 30;
/** A run counts as under way while its last event is this recent and it has no outcome. */
export const LIVE_RUN_WINDOW_MS = 2 * 60_000;

const isOutcome = (event: JobEvent) =>
  event.type === "run.completed" || event.type === "run.failed";

interface Run {
  runId: string;
  scenario?: RunScenario;
  startedAt?: string;
  /** Kept past the replay cap, so a long run still counts as under way. */
  lastEventAt?: string;
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
    if (run.events.length < MAX_EVENTS_PER_RUN || isOutcome(event)) run.events.push(event);
    run.lastEventAt = event.ts;
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

  /** Every run kept, oldest first (the release scheduler reads them at startup). */
  all(): RunLog[] {
    return [...this.runs.values()].map((run) => ({ ...run, events: [...run.events] }));
  }

  /** The run that holds an escrow lock, from its escrow.locked event, and its release if seen. */
  findLock(lockTxHash: string):
    | {
        runId: string;
        jobId?: string;
        outputIndex?: number;
        unlockTime: number;
        releasedTxHash?: string;
      }
    | undefined {
    for (const run of this.runs.values()) {
      const locked = run.events.find(
        (e): e is Extract<JobEvent, { type: "escrow.locked" }> =>
          e.type === "escrow.locked" && e.data.txHash === lockTxHash,
      );
      if (!locked) continue;
      const released = run.events.find(
        (e): e is Extract<JobEvent, { type: "escrow.released" }> =>
          e.type === "escrow.released" && e.data.lockTxHash === lockTxHash,
      );
      return {
        runId: run.runId,
        ...(locked.jobId ? { jobId: locked.jobId } : {}),
        ...(locked.data.outputIndex !== undefined ? { outputIndex: locked.data.outputIndex } : {}),
        unlockTime: Number(locked.data.unlockTime),
        ...(released ? { releasedTxHash: released.data.txHash } : {}),
      };
    }
    return undefined;
  }

  /**
   * A run under way right now, hosted or not (the MCP's, the CLI's): it started (a run.started,
   * which only the agent's token can post; a bare quote with a run id never counts), its latest
   * event is at most `windowMs` old, and it has no run.completed or run.failed. Events after the
   * outcome (an escrow's result or release) never make a run live again.
   */
  liveRun(now: number, windowMs = LIVE_RUN_WINDOW_MS): string | undefined {
    for (const run of this.runs.values()) {
      const last = run.lastEventAt ?? run.events.at(-1)?.ts;
      if (!run.startedAt || !last || run.events.some(isOutcome)) continue;
      if (now - Date.parse(last) <= windowMs) return run.runId;
    }
    return undefined;
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
