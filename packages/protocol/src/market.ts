import { z } from "zod";
import { NETWORK } from "./constants.js";
import {
  AssetId,
  AtomicAmount,
  CardanoAddress,
  Hex64,
  Id,
  IsoDate,
  PosixMs,
  Sha256,
  TxHash,
  WorkerId,
} from "./primitives.js";
import { ComputeRequest } from "./request.js";
import { WorkloadName } from "./workloads.js";

// Matching (PLAN 6.1) -------------------------------------------------------------------------

export const RejectionReason = z.enum([
  "offline",
  "untrusted",
  "not_calibrated",
  "busy",
  "outside_hours",
  "no_workload",
  "excluded",
  "no_gpu",
  "vram_too_small",
  "too_slow",
  "over_budget",
]);
export type RejectionReason = z.infer<typeof RejectionReason>;

/**
 * The order of the eligibility checks: the first failing check names the rejection. Hardware
 * reasons come first so the story reads right ("B: no GPU", not "B: not calibrated").
 * `over_budget` is decided afterwards, for eligible workers above the budget.
 */
export const ELIGIBILITY_ORDER = [
  "excluded",
  "no_gpu",
  "vram_too_small",
  "no_workload",
  "offline",
  "untrusted",
  "not_calibrated",
  "busy",
  "outside_hours",
  "too_slow",
] as const satisfies readonly RejectionReason[];

export const Rejection = z.object({
  workerId: WorkerId,
  reason: RejectionReason,
  /** Plain language, e.g. "$0.05 > $0.03". */
  detail: z.string(),
});
export type Rejection = z.infer<typeof Rejection>;

export const OfferKind = z.enum(["exact", "counter"]);
export type OfferKind = z.infer<typeof OfferKind>;

export const Offer = z.object({
  offerId: Id,
  quoteId: Id,
  workerId: WorkerId,
  workload: WorkloadName,
  priceUsd: z.number().positive(),
  priceAtomic: AtomicAmount,
  asset: AssetId,
  /** The worker's PAYOUT_ADDRESS: the worker that is paid is the worker that ran the job. */
  payTo: CardanoAddress,
  estSec: z.number().nonnegative(),
  expiresAt: IsoDate,
  kind: OfferKind,
});
export type Offer = z.infer<typeof Offer>;

export const CounterOffer = Offer.extend({
  /** e.g. "No offer at or below $0.015. Market price $0.03. Next best: C at $0.02, about 31 s". */
  reason: z.string(),
});
export type CounterOffer = z.infer<typeof CounterOffer>;

export const Quote = z.object({
  quoteId: Id,
  runId: Id.optional(),
  request: ComputeRequest,
  offers: z.array(Offer),
  counterOffer: CounterOffer.optional(),
  /** Median price of all eligible workers (lower middle for an even count); null if none. */
  marketPriceUsd: z.number().nullable(),
  rejected: z.array(Rejection),
  expiresAt: IsoDate,
});
export type Quote = z.infer<typeof Quote>;

// Jobs and receipts -----------------------------------------------------------------------------

export const JobStatus = z.enum(["dispatched", "running", "delivered", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z.object({
  jobId: Id,
  offerId: Id,
  runId: Id.optional(),
  workerId: WorkerId,
  txHash: TxHash,
  status: JobStatus,
  startedAt: IsoDate,
  endedAt: IsoDate.optional(),
  durationMs: z.number().nonnegative().optional(),
  sha256: Sha256.optional(),
  mime: z.string().optional(),
  paid: z.boolean(),
  error: z.string().optional(),
});
export type Job = z.infer<typeof Job>;

export const JobResultBody = z.object({
  jobId: Id,
  workerId: WorkerId,
  workload: WorkloadName,
  durationMs: z.number().nonnegative(),
  sha256: Sha256,
  mime: z.string(),
  resultUrl: z.string(),
  txHash: TxHash,
});
export type JobResultBody = z.infer<typeof JobResultBody>;

/** `default` pays the worker directly; `masumi` locks the funds in Masumi's escrow. */
export const TransferMethod = z.enum(["default", "masumi"]);
export type TransferMethod = z.infer<typeof TransferMethod>;

export const PaymentReceipt = z.object({
  txHash: TxHash,
  network: z.literal(NETWORK),
  /** The worker's address, or the Masumi escrow address for `masumi`. */
  payTo: CardanoAddress,
  amountAtomic: AtomicAmount,
  asset: AssetId,
  transferMethod: TransferMethod,
  confirmations: z.number().int().nonnegative().optional(),
  /** From the decoded signed transaction. */
  feeLovelace: AtomicAmount.optional(),
  /** The minimum ADA that travels with every token output (about 1.2 tADA). */
  lovelaceInPaymentOutput: AtomicAmount.optional(),
  explorerUrl: z.string().url(),
  settledAt: IsoDate,
});
export type PaymentReceipt = z.infer<typeof PaymentReceipt>;

/** Masumi escrow lock details (PR-10), from the decoded tx and the signed terms (`extra.terms`). */
export const EscrowLock = z.object({
  txHash: TxHash,
  escrowAddress: CardanoAddress,
  /** The selected worker's address (`terms.sellerAddress`). */
  sellerAddress: CardanoAddress,
  amountAtomic: AtomicAmount,
  asset: AssetId,
  collateralLovelace: AtomicAmount,
  /** `terms.inputHash`: the commitment to the exact request the agent quoted. */
  inputHash: Hex64,
  payByTime: PosixMs,
  submitResultTime: PosixMs,
  unlockTime: PosixMs,
  externalDisputeUnlockTime: PosixMs,
  explorerUrl: z.string().url(),
});
export type EscrowLock = z.infer<typeof EscrowLock>;
