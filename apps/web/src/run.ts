import { type EventOf, type JobEvent, ScenarioName } from "@pekkah/protocol";

// Everything the page shows about a run is derived here from the events the
// backend emitted, in their order. Nothing is inferred beyond them: a step that
// has no event has not happened.

/** One payment attempt: an offer my agent tried to buy (failover has two). */
export interface Attempt {
  offerId?: string;
  workerId?: string;
  txHash?: string;
  jobId?: string;
  required?: EventOf<"payment.required">;
  signed?: EventOf<"payment.signed">;
  verified?: EventOf<"payment.verified">;
  dispatched?: EventOf<"job.dispatched">;
  running?: EventOf<"job.running">;
  progress?: EventOf<"job.progress">;
  completed?: EventOf<"job.completed">;
  jobFailed?: EventOf<"job.failed">;
  settling?: EventOf<"payment.settling">;
  settled?: EventOf<"payment.settled">;
  canceled?: EventOf<"payment.canceled">;
  paymentFailed?: EventOf<"payment.failed">;
  receipt?: EventOf<"receipt.issued">;
  escrow?: EventOf<"escrow.locked">;
  /** The escrow's later steps, matched to the lock by its tx hash. */
  resultSubmitted?: EventOf<"escrow.result_submitted">;
  released?: EventOf<"escrow.released">;
  refunded?: EventOf<"escrow.refunded">;
}

export type RunStatus = "running" | "completed" | "failed";

export interface RunView {
  runId: string;
  /** Unset for a free-form run (scenario "custom", from the MCP or the CLI). */
  scenario?: ScenarioName;
  /** Who started the run, as run.started says, e.g. "Claude via MCP". */
  client?: string;
  started?: EventOf<"run.started">;
  quotes: EventOf<"quote.issued">[];
  decisions: EventOf<"agent.decision">[];
  reroutes: EventOf<"agent.reroute">[];
  attempts: Attempt[];
  completed?: EventOf<"run.completed">;
  failed?: EventOf<"run.failed">;
  status: RunStatus;
  /** The run's events in emission order. */
  events: JobEvent[];
  /** First and last event times. */
  firstTs?: string;
  lastTs?: string;
}

/** ulids sort in emission order. */
export function byId(a: JobEvent, b: JobEvent): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Events that belong to runs (dev test jobs never count as runs). */
export function runEvents(events: readonly JobEvent[], runId: string): JobEvent[] {
  return events.filter((e) => e.runId === runId && !e.dev).sort(byId);
}

/** A preset scenario's name, or undefined for anything else, such as a "custom" run. */
export function knownScenario(name: string): ScenarioName | undefined {
  return ScenarioName.safeParse(name).data;
}

/** runIds in the order their runs started (oldest first). */
export function runIds(events: readonly JobEvent[]): string[] {
  const ids: string[] = [];
  for (const e of [...events].sort(byId)) {
    if (e.type === "run.started" && e.runId && !e.dev && !ids.includes(e.runId)) ids.push(e.runId);
  }
  return ids;
}

export function deriveRun(runId: string, all: readonly JobEvent[]): RunView {
  const events = runEvents(all, runId);
  const view: RunView = {
    runId,
    quotes: [],
    decisions: [],
    reroutes: [],
    attempts: [],
    status: "running",
    events,
    firstTs: events[0]?.ts,
    lastTs: events[events.length - 1]?.ts,
  };
  const byOffer = new Map<string, Attempt>();
  const byTx = new Map<string, Attempt>();
  const byJob = new Map<string, Attempt>();

  const newAttempt = (): Attempt => {
    const attempt: Attempt = {};
    view.attempts.push(attempt);
    return attempt;
  };
  const last = (): Attempt => view.attempts[view.attempts.length - 1] ?? newAttempt();
  const link = (attempt: Attempt, ids: { offerId?: string; txHash?: string; jobId?: string }) => {
    if (ids.offerId) {
      attempt.offerId ??= ids.offerId;
      byOffer.set(ids.offerId, attempt);
    }
    if (ids.txHash) {
      attempt.txHash ??= ids.txHash;
      byTx.set(ids.txHash, attempt);
    }
    if (ids.jobId) {
      attempt.jobId ??= ids.jobId;
      byJob.set(ids.jobId, attempt);
    }
    return attempt;
  };
  const find = (ids: { offerId?: string; txHash?: string; jobId?: string }): Attempt | undefined =>
    (ids.txHash && byTx.get(ids.txHash)) ||
    (ids.offerId && byOffer.get(ids.offerId)) ||
    (ids.jobId && byJob.get(ids.jobId)) ||
    undefined;

  for (const e of events) {
    switch (e.type) {
      case "run.started":
        view.started = e;
        view.scenario = knownScenario(e.data.scenario);
        view.client = e.data.client;
        break;
      case "quote.issued":
        view.quotes.push(e);
        break;
      case "agent.decision":
        view.decisions.push(e);
        break;
      case "agent.reroute":
        view.reroutes.push(e);
        break;
      case "payment.required": {
        const ids = { offerId: e.data.offerId };
        const a = link(find(ids) ?? newAttempt(), ids);
        a.workerId ??= e.data.workerId;
        a.required = e;
        break;
      }
      case "payment.signed": {
        const ids = { offerId: e.data.offerId, txHash: e.data.txHash };
        const a = link(find(ids) ?? last(), ids);
        a.signed = e;
        break;
      }
      case "payment.verified": {
        const ids = { offerId: e.data.offerId, txHash: e.data.txHash };
        const a = link(find(ids) ?? last(), ids);
        a.workerId ??= e.data.workerId;
        a.verified = e;
        break;
      }
      case "job.dispatched": {
        if (e.data.kind !== "paid") break;
        const ids = { offerId: e.data.offerId, txHash: e.data.txHash, jobId: e.jobId };
        const a = link(find(ids) ?? last(), ids);
        a.workerId ??= e.data.workerId;
        a.dispatched = e;
        break;
      }
      case "job.running":
      case "job.progress":
      case "job.completed":
      case "job.failed": {
        const a = (e.jobId && byJob.get(e.jobId)) || last();
        if (e.type === "job.running") a.running = e;
        else if (e.type === "job.progress") a.progress = e;
        else if (e.type === "job.completed") a.completed = e;
        else a.jobFailed = e;
        break;
      }
      case "payment.settling":
      case "payment.settled":
      case "payment.canceled":
      case "payment.failed": {
        const a = (e.data.txHash && byTx.get(e.data.txHash)) || last();
        if (e.type === "payment.settling") a.settling = e;
        else if (e.type === "payment.settled") a.settled = e;
        else if (e.type === "payment.canceled") a.canceled = e;
        else a.paymentFailed = e;
        break;
      }
      case "receipt.issued": {
        const a = byTx.get(e.data.receipt.txHash) ?? last();
        a.receipt = e;
        break;
      }
      case "escrow.locked": {
        const a = byTx.get(e.data.txHash) ?? last();
        a.escrow = e;
        break;
      }
      // The lock is the payment's transaction, so its hash finds the attempt.
      case "escrow.result_submitted": {
        const a = byTx.get(e.data.lockTxHash) ?? last();
        a.resultSubmitted = e;
        break;
      }
      case "escrow.released": {
        const a = byTx.get(e.data.lockTxHash) ?? last();
        a.released = e;
        break;
      }
      case "escrow.refunded": {
        const a = byTx.get(e.data.lockTxHash) ?? last();
        a.refunded = e;
        break;
      }
      case "run.completed":
        view.completed = e;
        view.status = "completed";
        break;
      case "run.failed":
        view.failed = e;
        view.status = "failed";
        break;
      default:
        break;
    }
  }
  return view;
}

/** The steps of one payment, in the order they happen. */
export const PAYMENT_STEPS = [
  "required",
  "signed",
  "verified",
  "running",
  "delivered",
  "settling",
  "settled",
] as const;
export type PaymentStep = (typeof PAYMENT_STEPS)[number];

export type StepState = "done" | "active" | "failed" | "pending";

/**
 * Where an attempt is on the 402 → settled path, from its events only. A step is
 * `done` when its event arrived, `active` when it is the latest step reached and
 * the attempt is still open, `failed` when the attempt ended there.
 */
export function stepStates(a: Attempt): Record<PaymentStep, StepState> {
  const reached: Record<PaymentStep, boolean> = {
    required: Boolean(a.required),
    signed: Boolean(a.signed),
    verified: Boolean(a.verified),
    // Dispatched is not running yet: only the worker's own events count.
    running: Boolean(a.running || a.progress),
    delivered: Boolean(a.completed),
    settling: Boolean(a.settling),
    settled: Boolean(a.settled),
  };
  const ended = Boolean(a.settled || a.canceled || a.paymentFailed || a.jobFailed);
  let furthest = -1;
  PAYMENT_STEPS.forEach((step, i) => {
    if (reached[step]) furthest = i;
  });
  const failedAt = a.jobFailed ? PAYMENT_STEPS.indexOf("running") : a.paymentFailed ? furthest : -1;
  const out = {} as Record<PaymentStep, StepState>;
  PAYMENT_STEPS.forEach((step, i) => {
    if (i === failedAt) out[step] = "failed";
    else if (reached[step] && (i < furthest || ended || step === "settled")) out[step] = "done";
    else if (reached[step]) out[step] = "active";
    else out[step] = "pending";
  });
  return out;
}

/** Is this the Masumi escrow path (funds locked, never "paid")? */
export function isEscrow(a: Attempt): boolean {
  return (
    a.required?.data.transferMethod === "masumi" ||
    a.verified?.data.transferMethod === "masumi" ||
    a.receipt?.data.receipt.transferMethod === "masumi" ||
    Boolean(a.escrow)
  );
}

/**
 * My agent's latest balance: from the given run when it reported one (the hosted agent and the
 * MCP pay from different accounts), else from any run.
 */
export function latestBalance(
  events: readonly JobEvent[],
  runId?: string,
): EventOf<"agent.balance"> | undefined {
  let any: EventOf<"agent.balance"> | undefined;
  let ofRun: EventOf<"agent.balance"> | undefined;
  for (const e of events) {
    if (e.type !== "agent.balance") continue;
    if (!any || e.id > any.id) any = e;
    if (runId && e.runId === runId && (!ofRun || e.id > ofRun.id)) ofRun = e;
  }
  return ofRun ?? any;
}

/** The parts of the story, in page order. Each panel carries its step as data-step. */
export const STORY_STEPS = ["request", "decision", "payment", "result", "escrow"] as const;
export type StoryStep = (typeof STORY_STEPS)[number];

const STEP_OF: Partial<Record<JobEvent["type"], StoryStep>> = {
  "run.started": "request",
  "quote.issued": "decision",
  "agent.decision": "decision",
  "agent.reroute": "decision",
  "payment.required": "payment",
  "payment.signed": "payment",
  "payment.verified": "payment",
  "job.dispatched": "payment",
  "job.running": "payment",
  "job.progress": "payment",
  "job.completed": "payment",
  "job.failed": "payment",
  "payment.settling": "payment",
  "payment.settled": "payment",
  "payment.canceled": "payment",
  "payment.failed": "payment",
  // The lock is how an escrow run pays, so it stays with the payment until the receipt.
  "escrow.locked": "payment",
  "receipt.issued": "result",
  "escrow.result_submitted": "escrow",
  "escrow.released": "escrow",
  "escrow.refunded": "escrow",
};

/**
 * The part of the story the newest event belongs to. Events that don't move the story (the
 * balance, the run's end) keep the step where it was.
 */
export function currentStep(run: Pick<RunView, "events">): StoryStep | undefined {
  for (let i = run.events.length - 1; i >= 0; i--) {
    const step = STEP_OF[run.events[i]?.type as JobEvent["type"]];
    if (step) return step;
  }
  return undefined;
}

/** A run opened mid-way counts as live while unfinished with an event this recent. */
export const LIVE_WINDOW_MS = 15 * 60_000;
/** The server refuses a new run (409) while another is unfinished with an event this recent. */
export const BUSY_WINDOW_MS = 2 * 60_000;

/** Unfinished: started, with no run.completed or run.failed yet. */
export function isUnfinished(run: Pick<RunView, "started" | "status">): boolean {
  return Boolean(run.started) && run.status === "running";
}

/** An unfinished run whose last event is within `windowMs` of `now`. */
export function isRecentUnfinished(
  run: Pick<RunView, "started" | "status" | "lastTs">,
  now: number,
  windowMs: number,
): boolean {
  return isUnfinished(run) && run.lastTs !== undefined && now - Date.parse(run.lastTs) < windowMs;
}

/**
 * The run that blocks the run buttons, by the server's 409 rule: started, not finished, with an
 * event in the last 2 minutes. Only runs whose start is in view count.
 */
export function busyRunId(events: readonly JobEvent[], now: number): string | undefined {
  const runs = new Map<string, { ended: boolean; last: number }>();
  for (const e of events) {
    if (!e.runId || e.dev) continue;
    const t = Date.parse(e.ts);
    const r = runs.get(e.runId);
    if (e.type === "run.started") {
      runs.set(e.runId, { ended: r?.ended ?? false, last: Math.max(r?.last ?? 0, t) });
      continue;
    }
    if (!r) continue;
    if (e.type === "run.completed" || e.type === "run.failed") r.ended = true;
    r.last = Math.max(r.last, t);
  }
  for (const [runId, r] of runs) {
    if (!r.ended && now - r.last < BUSY_WINDOW_MS) return runId;
  }
  return undefined;
}
