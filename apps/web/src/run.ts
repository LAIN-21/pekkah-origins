import type { EventOf, JobEvent, ScenarioName } from "@pekkah/protocol";

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
}

export type RunStatus = "running" | "completed" | "failed";

export interface RunView {
  runId: string;
  scenario?: ScenarioName;
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
        view.scenario = e.data.scenario;
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

/** The latest agent.balance event, from any run. */
export function latestBalance(events: readonly JobEvent[]): EventOf<"agent.balance"> | undefined {
  let found: EventOf<"agent.balance"> | undefined;
  for (const e of events) {
    if (e.type === "agent.balance" && (!found || e.id > found.id)) found = e;
  }
  return found;
}
