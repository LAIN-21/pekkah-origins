import {
  type CounterOffer,
  formatUsd,
  formatUsdAtomic,
  type Offer,
  type Quote,
  type ScenarioName,
  usdToAtomic,
} from "@pekkah/protocol";

/**
 * My agent's private ceilings (PLAN 6.4). They never leave the agent in a request: the
 * market sees only the budget. Kept here, not in packages/protocol, which ships to browsers.
 */
export const PRIVATE_CEILINGS_USD: Record<ScenarioName, number> = {
  "gpu-image": 0.05,
  "cpu-counter": 0.03,
  "cpu-tight": 0.03,
  failover: 0.04,
  "gpu-image-escrow": 0.05,
  "fractal-escrow": 0.05,
};

export interface Decision {
  kind: "exact" | "counter" | "declined";
  chosen?: Offer | CounterOffer;
  reasons: string[];
}

const about = (sec: number) => `about ${Math.round(sec)} s`;

/**
 * Takes the exact offer at the top. Otherwise takes the counter-offer if its price is within
 * my private ceiling and its estimate within the deadline. Otherwise declines (PLAN 6.1).
 */
export function decide(quote: Quote, ceilingUsd: number): Decision {
  const deadline = quote.request.constraints.deadlineSec;
  const budget = formatUsd(quote.request.budget.maxUsd);
  const exact = quote.offers[0];
  if (exact) {
    return {
      kind: "exact",
      chosen: exact,
      reasons: [
        `${exact.workerId} offers ${formatUsdAtomic(exact.priceAtomic)}, ${about(exact.estSec)}, within my budget of ${budget}.`,
      ],
    };
  }
  const counter = quote.counterOffer;
  if (!counter) {
    return {
      kind: "declined",
      reasons: [
        "No worker can run this job now.",
        ...quote.rejected.map((r) => `${r.workerId}: ${r.detail}`),
      ],
    };
  }
  const reasons = [counter.reason];
  if (BigInt(counter.priceAtomic) > BigInt(usdToAtomic(ceilingUsd))) {
    reasons.push(
      `${formatUsdAtomic(counter.priceAtomic)} is above my private ceiling of ${formatUsd(ceilingUsd)}: declined.`,
    );
    return { kind: "declined", reasons };
  }
  if (counter.estSec > deadline) {
    reasons.push(`${about(counter.estSec)} misses my ${deadline} s deadline: declined.`);
    return { kind: "declined", reasons };
  }
  reasons.push(
    `${counter.workerId} at ${formatUsdAtomic(counter.priceAtomic)} is within my private ceiling of ${formatUsd(ceilingUsd)} and my ${deadline} s deadline: accepted.`,
  );
  return { kind: "counter", chosen: counter, reasons };
}
