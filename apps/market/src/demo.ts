import {
  type DemoRunRequest,
  type DemoState,
  isPublicScenario,
  type ScenarioName,
} from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import { monotonicFactory } from "ulid";
import type { EventBus } from "./events.js";

const nextRunId = monotonicFactory();
/** A run that never reports its end (the agent died) frees the button after this. */
const RUN_TIMEOUT_MS = 15 * 60_000;

export interface DemoOptions {
  agentUrl: string;
  agentToken: string;
  cooldownSec: number;
  dailyRuns: number;
  bus: EventBus;
  log: Logger;
  /** Called whenever the state the run button shows changes. */
  onChange: () => void;
  now?: () => number;
}

export type DemoStart =
  | { status: 202; body: { runId: string; scenario: ScenarioName } }
  | { status: 403 | 409 | 429 | 502; body: { error: string; [key: string]: unknown } };

/** Days are counted in Singapore time, where the demo runs. */
function sgtDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(ms);
}

/**
 * The public run button (PLAN 5.4): public scenarios only, one run at a time, a cooldown
 * between runs and a daily cap, so nobody can drain the wallet. Bearer DEMO_TOKEN skips the
 * cooldown and the cap and allows every scenario. The market creates the runId and hands the
 * run to the agent service; the run ends when its run.completed or run.failed event arrives.
 */
export class DemoController {
  private running: { runId: string; scenario: ScenarioName; timer: NodeJS.Timeout } | null = null;
  private cooldownUntil = 0;
  private day = "";
  private publicRuns = 0;
  private readonly now: () => number;

  constructor(private readonly o: DemoOptions) {
    this.now = o.now ?? Date.now;
    o.bus.subscribe((event) => {
      if (!this.running || event.runId !== this.running.runId) return;
      if (event.type === "run.completed" || event.type === "run.failed") this.finish();
    });
  }

  private runsLeft(): number {
    const today = sgtDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.publicRuns = 0;
    }
    return Math.max(0, this.o.dailyRuns - this.publicRuns);
  }

  state(): DemoState {
    const now = this.now();
    return {
      running: this.running !== null,
      ...(this.running ? { runId: this.running.runId } : {}),
      cooldownUntil: this.cooldownUntil > now ? new Date(this.cooldownUntil).toISOString() : null,
      runsLeftToday: this.runsLeft(),
    };
  }

  async start(request: DemoRunRequest, privileged: boolean): Promise<DemoStart> {
    if (!privileged && !isPublicScenario(request.scenario)) {
      return { status: 403, body: { error: "scenario_not_public" } };
    }
    if (this.running) {
      return { status: 409, body: { error: "run_in_progress", runId: this.running.runId } };
    }
    if (!privileged) {
      if (this.now() < this.cooldownUntil) {
        return {
          status: 429,
          body: { error: "cooldown", cooldownUntil: new Date(this.cooldownUntil).toISOString() },
        };
      }
      if (this.runsLeft() <= 0) return { status: 429, body: { error: "daily_limit" } };
    }

    const runId = nextRunId();
    try {
      const res = await fetch(`${this.o.agentUrl.replace(/\/+$/, "")}/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.o.agentToken}`,
        },
        body: JSON.stringify({
          scenario: request.scenario,
          runId,
          ...(request.promptIndex !== undefined ? { promptIndex: request.promptIndex } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status !== 202) {
        this.o.log.warn({ status: res.status }, "the agent service refused a run");
        return { status: 502, body: { error: "agent_unavailable" } };
      }
    } catch (err) {
      this.o.log.warn(
        { err: err instanceof Error ? err.message : err },
        "agent service unreachable",
      );
      return { status: 502, body: { error: "agent_unavailable" } };
    }

    if (!privileged) {
      this.runsLeft();
      this.publicRuns += 1;
    }
    this.running = {
      runId,
      scenario: request.scenario,
      timer: setTimeout(() => this.finish(), RUN_TIMEOUT_MS),
    };
    this.o.log.info({ runId, scenario: request.scenario, privileged }, "demo run started");
    this.o.onChange();
    return { status: 202, body: { runId, scenario: request.scenario } };
  }

  private finish(): void {
    if (!this.running) return;
    clearTimeout(this.running.timer);
    this.o.log.info({ runId: this.running.runId }, "demo run ended");
    this.running = null;
    this.cooldownUntil = this.now() + this.o.cooldownSec * 1000;
    this.o.onChange();
  }

  close(): void {
    if (this.running) clearTimeout(this.running.timer);
  }
}
