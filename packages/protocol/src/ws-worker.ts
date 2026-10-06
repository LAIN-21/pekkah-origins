import { z } from "zod";
import { HELLO_LIMITS, RESULT_MAX_BYTES } from "./constants.js";
import { JobKind } from "./events.js";
import { CardanoAddress, Id, IsoDate, Sha256, WorkerId } from "./primitives.js";
import { WorkerHardware, WorkerUtil } from "./worker.js";
import { FractalParams, ImageParams, WorkloadName } from "./workloads.js";

// Worker WebSocket, /ws/worker (PLAN 5.3). JSON messages; max payload 32 MB.
// Auth: the token in `hello` must match WORKER_TOKENS[workerId]. Silent for 15 s → offline.

// worker → market -----------------------------------------------------------------------------

export const HelloMsg = z.object({
  type: z.literal("hello"),
  workerId: WorkerId,
  /** WORKER_TOKENS[workerId] for an allowlisted worker. PR-17: without one, probation. */
  token: z.string().min(1).optional(),
  /** The worker's git sha. */
  version: z.string().max(HELLO_LIMITS.version),
  name: z.string().min(1).max(HELLO_LIMITS.name),
  /** The worker's PAYOUT_ADDRESS. */
  payTo: CardanoAddress,
  hardware: WorkerHardware,
  prices: z
    .array(z.object({ workload: WorkloadName, usd: z.number().positive() }))
    .max(HELLO_LIMITS.prices),
  schedule: z.string().max(HELLO_LIMITS.schedule).optional(),
  warm: z.array(WorkloadName),
});
export type HelloMsg = z.infer<typeof HelloMsg>;

/** Every 5 s, every 2 s while busy. `warm` is the list of workloads ready right now. */
export const HeartbeatMsg = z.object({
  type: z.literal("heartbeat"),
  busy: z.boolean(),
  currentJobId: Id.optional(),
  util: WorkerUtil,
  warm: z.array(WorkloadName),
});
export type HeartbeatMsg = z.infer<typeof HeartbeatMsg>;

export const JobAcceptedMsg = z.object({ type: z.literal("job.accepted"), jobId: Id });
export type JobAcceptedMsg = z.infer<typeof JobAcceptedMsg>;

export const JobProgressMsg = z.object({
  type: z.literal("job.progress"),
  jobId: Id,
  pct: z.number().min(0).max(100),
  note: z.string().max(200).optional(),
});
export type JobProgressMsg = z.infer<typeof JobProgressMsg>;

export const JobResultOkMsg = z.object({
  type: z.literal("job.result"),
  jobId: Id,
  ok: z.literal(true),
  mime: z.string().min(1),
  sha256: Sha256,
  bytes: z.number().int().nonnegative().max(RESULT_MAX_BYTES),
  dataBase64: z.string(),
  durationMs: z.number().nonnegative(),
});
export type JobResultOkMsg = z.infer<typeof JobResultOkMsg>;

export const JobResultErrMsg = z.object({
  type: z.literal("job.result"),
  jobId: Id,
  ok: z.literal(false),
  error: z.string().max(2000),
  durationMs: z.number().nonnegative(),
});
export type JobResultErrMsg = z.infer<typeof JobResultErrMsg>;

export type JobResultMsg = JobResultOkMsg | JobResultErrMsg;

export const WorkerToMarket = z.union([
  HelloMsg,
  HeartbeatMsg,
  JobAcceptedMsg,
  JobProgressMsg,
  JobResultOkMsg,
  JobResultErrMsg,
]);
export type WorkerToMarket = z.infer<typeof WorkerToMarket>;

// market → worker -----------------------------------------------------------------------------

export const WelcomeMsg = z.object({
  type: z.literal("welcome"),
  workerId: WorkerId,
  serverTime: IsoDate,
});
export type WelcomeMsg = z.infer<typeof WelcomeMsg>;

const dispatch = {
  type: z.literal("job.dispatch"),
  jobId: Id,
  kind: JobKind,
  deadlineSec: z.number().int().min(1).max(300),
};

export const JobDispatchFractalMsg = z.object({
  ...dispatch,
  workload: z.literal("fractal"),
  params: FractalParams,
});
export const JobDispatchImageMsg = z.object({
  ...dispatch,
  workload: z.literal("image"),
  params: ImageParams,
});
export type JobDispatchMsg =
  | z.infer<typeof JobDispatchFractalMsg>
  | z.infer<typeof JobDispatchImageMsg>;

export const JobCancelMsg = z.object({
  type: z.literal("job.cancel"),
  jobId: Id,
  reason: z.string(),
});
export type JobCancelMsg = z.infer<typeof JobCancelMsg>;

/** Sent before the market closes the connection. */
export const ErrorMsg = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});
export type ErrorMsg = z.infer<typeof ErrorMsg>;

export const MarketToWorker = z.union([
  WelcomeMsg,
  JobDispatchFractalMsg,
  JobDispatchImageMsg,
  JobCancelMsg,
  ErrorMsg,
]);
export type MarketToWorker = z.infer<typeof MarketToWorker>;
