import {
  type ComputeRequest,
  compareAtomic,
  formatUsd,
  formatUsdAtomic,
  type Rejection,
  type RejectionReason,
  usdToAtomic,
  type WorkerPrice,
  type WorkerSnapshot,
} from "@pekkah/protocol";
import { estimateSec } from "./estimates.js";
import { withinSchedule } from "./schedule.js";

/** An eligible worker for a request, with its price and measured estimate. */
export interface Candidate {
  workerId: string;
  payTo: string;
  priceUsd: number;
  priceAtomic: string;
  estSec: number;
}

export interface MatchResult {
  /** Eligible workers at or below the budget: by price, then estimate, then id. */
  offers: Candidate[];
  /** When nothing fits the budget: the cheapest eligible worker, and why. */
  counterOffer?: Candidate & { reason: string };
  /** Median price of all eligible workers (the lower middle for an even count). */
  marketPriceUsd: number | null;
  rejected: Rejection[];
}

const byPrice = (a: Candidate, b: Candidate) =>
  compareAtomic(a.priceAtomic, b.priceAtomic) ||
  a.estSec - b.estSec ||
  a.workerId.localeCompare(b.workerId);

const gb = (n: number) => `${Math.round(n * 10) / 10} GB`;
const sec = (n: number) => `${Math.round(n)} s`;

type Check = [RejectionReason, string] | null;

/**
 * The first failing check names the rejection, in PLAN 6.1's order. Hardware comes first so
 * the story reads right ("B: no GPU", not "B: not calibrated").
 */
function eligibility(
  request: ComputeRequest,
  w: WorkerSnapshot,
  price: WorkerPrice | undefined,
  now: Date,
): { check: Check; estSec: number | null } {
  const c = request.constraints;
  const minVram = c.minVramGb ?? 0;
  const gpu = w.hardware.gpu;
  const fail = (reason: RejectionReason, detail: string) => ({
    check: [reason, detail] as [RejectionReason, string],
    estSec: null,
  });
  if (c.exclude?.includes(w.workerId)) return fail("excluded", "excluded by the request");
  if ((c.gpu || minVram > 0) && !gpu) return fail("no_gpu", "no GPU");
  if (gpu && minVram > 0 && gpu.vramGb < minVram) {
    return fail("vram_too_small", `${gb(gpu.vramGb)} VRAM, needs ${gb(minVram)}`);
  }
  if (!price) return fail("no_workload", `does not sell ${request.workload}`);
  if (!w.warm.includes(request.workload))
    return fail("no_workload", `${request.workload} is not ready`);
  if (w.status === "offline") return fail("offline", "offline");
  if (w.status === "untrusted") return fail("untrusted", "failed the answer check");
  const estSec = estimateSec(request, w);
  if (estSec === null) return fail("not_calibrated", `${request.workload} not measured yet`);
  if (w.status === "calibrating") return fail("busy", "measuring itself");
  if (w.status === "busy" || w.currentJobId) return fail("busy", "running another job");
  if (!withinSchedule(w.schedule, now)) return fail("outside_hours", `sells ${w.schedule}`);
  if (estSec > c.deadlineSec) {
    return fail("too_slow", `about ${sec(estSec)}, deadline ${sec(c.deadlineSec)}`);
  }
  return { check: null, estSec };
}

/** The matcher (PLAN 6.1): a pure function of the request, the workers and the time. */
export function match(request: ComputeRequest, workers: WorkerSnapshot[], now: Date): MatchResult {
  const budget = usdToAtomic(request.budget.maxUsd);
  const eligible: Candidate[] = [];
  const rejected: Rejection[] = [];
  const sorted = [...workers].sort((a, b) => a.workerId.localeCompare(b.workerId));

  for (const w of sorted) {
    const price = w.prices.find((p) => p.workload === request.workload);
    const { check, estSec } = eligibility(request, w, price, now);
    if (check || !price || estSec === null) {
      const [reason, detail] = check ?? ["no_workload", "not offered"];
      rejected.push({ workerId: w.workerId, reason, detail });
      continue;
    }
    eligible.push({
      workerId: w.workerId,
      payTo: w.payTo,
      priceUsd: price.usd,
      priceAtomic: price.atomic,
      estSec,
    });
  }

  eligible.sort(byPrice);
  const offers: Candidate[] = [];
  for (const candidate of eligible) {
    if (compareAtomic(candidate.priceAtomic, budget) <= 0) offers.push(candidate);
    else {
      rejected.push({
        workerId: candidate.workerId,
        reason: "over_budget",
        detail: `${formatUsdAtomic(candidate.priceAtomic)} > ${formatUsd(request.budget.maxUsd)}`,
      });
    }
  }
  rejected.sort((a, b) => a.workerId.localeCompare(b.workerId));

  const median = eligible.length ? eligible[Math.floor((eligible.length - 1) / 2)] : undefined;
  const marketPriceUsd = median ? median.priceUsd : null;

  const result: MatchResult = { offers, marketPriceUsd, rejected };
  const cheapest = eligible[0];
  if (offers.length === 0 && cheapest) {
    result.counterOffer = {
      ...cheapest,
      reason:
        `No offer at or below ${formatUsd(request.budget.maxUsd)}. ` +
        `Market price ${formatUsd(marketPriceUsd ?? cheapest.priceUsd)}. ` +
        `Next best: ${cheapest.workerId} at ${formatUsdAtomic(cheapest.priceAtomic)}, about ${sec(cheapest.estSec)}`,
    };
  }
  return result;
}
