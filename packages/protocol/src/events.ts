import { z } from "zod";
import {
  CounterOffer,
  EscrowLock,
  Offer,
  PaymentReceipt,
  Quote,
  TransferMethod,
} from "./market.js";
import {
  AssetId,
  AtomicAmount,
  CardanoAddress,
  Id,
  IsoDate,
  Sha256,
  TxHash,
  WorkerId,
} from "./primitives.js";
import { ComputeRequest } from "./request.js";
import { RunScenario } from "./scenarios.js";
import { WorkloadName } from "./workloads.js";

// Events (PLAN 5.2). The UI shows only states the backend emitted, in the order they happened.

export const EventSource = z.enum(["agent", "market", "worker", "chain"]);
export type EventSource = z.infer<typeof EventSource>;

/** paid: a bought job; calibration: market-run measurement; dev: /api/dev/dispatch test job. */
export const JobKind = z.enum(["paid", "calibration", "dev"]);
export type JobKind = z.infer<typeof JobKind>;

const envelope = {
  /** ulid: sorts in emission order. */
  id: z.string().min(1),
  ts: IsoDate,
  runId: Id.optional(),
  jobId: Id.optional(),
  source: EventSource,
  /** From /api/dev/* test routes. Never shown as runs. */
  dev: z.literal(true).optional(),
};

function event<T extends string, D extends z.ZodTypeAny>(type: T, data: D) {
  return z.object({ ...envelope, type: z.literal(type), data });
}

// agent ---------------------------------------------------------------------------------------

export const RunStartedEvent = event(
  "run.started",
  z.object({
    scenario: RunScenario,
    request: ComputeRequest,
    /** Who started the run, for example "Claude via MCP". */
    client: z.string().min(1).max(40).optional(),
  }),
);
export const AgentDecisionEvent = event(
  "agent.decision",
  z.object({
    kind: z.enum(["exact", "counter", "declined"]),
    chosen: z.union([CounterOffer, Offer]).optional(),
    /** Plain-language reasons, shown as they are. */
    reasons: z.array(z.string()),
    /**
     * Present only when my agent states that I approved a price above my budget. It is my
     * agent's statement, never proof that I approved. The wallet's spend caps stay the limit.
     */
    overBudget: z
      .object({ budgetUsd: z.number().positive(), priceUsd: z.number().positive() })
      .optional(),
  }),
);
export const PaymentSignedEvent = event(
  "payment.signed",
  z.object({
    txHash: TxHash,
    payTo: CardanoAddress,
    amountAtomic: AtomicAmount,
    offerId: Id.optional(),
    transferMethod: TransferMethod.optional(),
    /** From this slot on the signed transaction can never land (proof for cancellations). */
    ttlSlot: z.string().regex(/^\d+$/).optional(),
  }),
);
export const AgentRerouteEvent = event(
  "agent.reroute",
  z.object({ excluded: z.array(WorkerId), reason: z.string() }),
);
export const AgentBalanceEvent = event(
  "agent.balance",
  z.object({ lovelace: AtomicAmount, assetAtomic: AtomicAmount }),
);
export const RunCompletedEvent = event(
  "run.completed",
  z.object({ jobId: Id, workerId: WorkerId, txHash: TxHash, totalMs: z.number().nonnegative() }),
);
export const RunFailedEvent = event("run.failed", z.object({ reason: z.string() }));

// market --------------------------------------------------------------------------------------

export const QuoteIssuedEvent = event("quote.issued", z.object({ quote: Quote }));
export const PaymentRequiredEvent = event(
  "payment.required",
  z.object({
    offerId: Id,
    workerId: WorkerId,
    payTo: CardanoAddress,
    amountAtomic: AtomicAmount,
    asset: AssetId,
    transferMethod: TransferMethod,
  }),
);
export const PaymentVerifiedEvent = event(
  "payment.verified",
  z.object({
    txHash: TxHash,
    offerId: Id,
    workerId: WorkerId,
    payTo: CardanoAddress,
    amountAtomic: AtomicAmount,
    transferMethod: TransferMethod,
  }),
);
export const JobDispatchedEvent = event(
  "job.dispatched",
  z.object({
    workerId: WorkerId,
    workload: WorkloadName,
    kind: JobKind,
    deadlineSec: z.number().positive(),
    offerId: Id.optional(),
    txHash: TxHash.optional(),
    estSec: z.number().nonnegative().optional(),
  }),
);
export const JobRunningEvent = event("job.running", z.object({ workerId: WorkerId }));
export const JobProgressEvent = event(
  "job.progress",
  z.object({ workerId: WorkerId, pct: z.number().min(0).max(100), note: z.string().optional() }),
);
export const JobCompletedEvent = event(
  "job.completed",
  z.object({
    workerId: WorkerId,
    durationMs: z.number().nonnegative(),
    sha256: Sha256,
    mime: z.string().optional(),
    bytes: z.number().int().nonnegative().optional(),
    /** The market's own check of an image result: a PNG of the requested size. */
    check: z
      .object({
        kind: z.literal("png"),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional(),
  }),
);
export const JobFailedEvent = event(
  "job.failed",
  z.object({ workerId: WorkerId, reason: z.string() }),
);
export const PaymentSettlingEvent = event(
  "payment.settling",
  z.object({ txHash: TxHash, transferMethod: TransferMethod.optional() }),
);
/** For `masumi`, settled means the lock transaction is on chain: "locked in escrow", never "paid". */
export const PaymentSettledEvent = event(
  "payment.settled",
  z.object({
    txHash: TxHash,
    confirmations: z.number().int().nonnegative().optional(),
    explorerUrl: z.string().url(),
    late: z.boolean().optional(),
    transferMethod: TransferMethod.optional(),
  }),
);
/** The handler failed after verify: settle never ran, so nothing was charged. */
export const PaymentCanceledEvent = event(
  "payment.canceled",
  z.object({ txHash: TxHash.optional(), reason: z.string() }),
);
export const PaymentFailedEvent = event(
  "payment.failed",
  z.object({ txHash: TxHash.optional(), reason: z.string() }),
);
export const ReceiptIssuedEvent = event(
  "receipt.issued",
  z.object({ receipt: PaymentReceipt, resultUrl: z.string() }),
);
export const WorkerOnlineEvent = event(
  "worker.online",
  z.object({ workerId: WorkerId, name: z.string() }),
);
export const WorkerOfflineEvent = event(
  "worker.offline",
  z.object({ workerId: WorkerId, name: z.string(), reason: z.string().optional() }),
);
export const WorkerCalibratedEvent = event(
  "worker.calibrated",
  z.object({
    workerId: WorkerId,
    workload: WorkloadName,
    verified: z.boolean(),
    sec: z.number().nonnegative(),
  }),
);
export const EscrowLockedEvent = event("escrow.locked", EscrowLock);
/**
 * PR-10b: the seller recorded the delivered result's hash in the escrow datum (Masumi
 * SubmitResult, state ResultSubmitted), seen on chain. The funds stay locked in escrow.
 */
export const EscrowResultSubmittedEvent = event(
  "escrow.result_submitted",
  z.object({
    lockTxHash: TxHash,
    txHash: TxHash,
    /** sha256 of the delivered result, as in job.completed. */
    resultHash: Sha256,
    explorerUrl: z.string().url(),
  }),
);
/**
 * PR-16: after the unlock time, the seller collected the price (Masumi Withdraw) and the
 * buyer's collateral came back, seen on chain. Only now may anything say "released".
 */
export const EscrowReleasedEvent = event(
  "escrow.released",
  z.object({
    lockTxHash: TxHash,
    txHash: TxHash,
    sellerAddress: CardanoAddress,
    buyerAddress: CardanoAddress,
    amountAtomic: AtomicAmount,
    asset: AssetId,
    collateralReturnLovelace: AtomicAmount,
    explorerUrl: z.string().url(),
  }),
);
/**
 * PR-16b: the buyer took back a lock with no result (Masumi WithdrawRefund): the price and the
 * collateral, seen on chain. Only now may anything say "refunded".
 */
export const EscrowRefundedEvent = event(
  "escrow.refunded",
  z.object({
    lockTxHash: TxHash,
    txHash: TxHash,
    buyerAddress: CardanoAddress,
    amountAtomic: AtomicAmount,
    asset: AssetId,
    collateralReturnLovelace: AtomicAmount,
    explorerUrl: z.string().url(),
  }),
);

export const JobEvent = z.discriminatedUnion("type", [
  RunStartedEvent,
  AgentDecisionEvent,
  PaymentSignedEvent,
  AgentRerouteEvent,
  AgentBalanceEvent,
  RunCompletedEvent,
  RunFailedEvent,
  QuoteIssuedEvent,
  PaymentRequiredEvent,
  PaymentVerifiedEvent,
  JobDispatchedEvent,
  JobRunningEvent,
  JobProgressEvent,
  JobCompletedEvent,
  JobFailedEvent,
  PaymentSettlingEvent,
  PaymentSettledEvent,
  PaymentCanceledEvent,
  PaymentFailedEvent,
  ReceiptIssuedEvent,
  WorkerOnlineEvent,
  WorkerOfflineEvent,
  WorkerCalibratedEvent,
  EscrowLockedEvent,
  EscrowResultSubmittedEvent,
  EscrowReleasedEvent,
  EscrowRefundedEvent,
]);
export type JobEvent = z.infer<typeof JobEvent>;
export type EventType = JobEvent["type"];
export type EventOf<T extends EventType> = Extract<JobEvent, { type: T }>;
export type EventData<T extends EventType> = EventOf<T>["data"];

export const EVENT_TYPES = JobEvent.options.map((o) => o.shape.type.value) as EventType[];

export const AGENT_EVENT_TYPES = [
  "run.started",
  "agent.decision",
  "payment.signed",
  "agent.reroute",
  "agent.balance",
  "run.completed",
  "run.failed",
] as const satisfies readonly EventType[];
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/** What the chain shows: the market emits these once the facilitator sees the transaction. */
export const CHAIN_EVENT_TYPES = [
  "payment.settled",
  "escrow.locked",
  "escrow.result_submitted",
  "escrow.released",
  "escrow.refunded",
] as const satisfies readonly EventType[];

/**
 * What a worker reports about its job. A failure the market decides (a missed deadline, a
 * disconnect, a result that fails the market's checks) is a market event.
 */
export const WORKER_EVENT_TYPES = [
  "job.running",
  "job.progress",
  "job.completed",
  "job.failed",
] as const satisfies readonly EventType[];

export function chainSourced(type: EventType): boolean {
  return (CHAIN_EVENT_TYPES as readonly string[]).includes(type);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a producer hands to the event bus; the bus stamps `id` and `ts`. */
export type JobEventInput = DistributiveOmit<JobEvent, "id" | "ts">;

/**
 * Chain events my agent may report through /api/agent-events (PR-16b: a refund it sent). The
 * market emits one only after it finds the transaction on chain, as a `chain` event.
 */
export const AGENT_REPORTED_CHAIN_TYPES = [
  "escrow.refunded",
] as const satisfies readonly (typeof CHAIN_EVENT_TYPES)[number][];
export type AgentReportedChainType = (typeof AGENT_REPORTED_CHAIN_TYPES)[number];

/**
 * One agent event as POSTed to /api/agent-events (Bearer AGENT_TOKEN). The market adds `id` and
 * `source: "agent"`, then validates the whole event with `JobEvent`. A reported chain event is
 * checked on chain first, and emitted with `source: "chain"`.
 */
export const AgentEventPost = z.object({
  type: z.enum([...AGENT_EVENT_TYPES, ...AGENT_REPORTED_CHAIN_TYPES]),
  data: z.unknown(),
  runId: Id.optional(),
  jobId: Id.optional(),
  ts: IsoDate.optional(),
});
export type AgentEventPost = z.infer<typeof AgentEventPost>;

export const AgentEventsBody = z.object({ events: z.array(AgentEventPost).min(1).max(50) });
export type AgentEventsBody = z.infer<typeof AgentEventsBody>;
