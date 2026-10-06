import {
  type EventOf,
  type JobEvent,
  MASUMI_LOCK_LABEL,
  MASUMI_REFUNDED_LABEL,
  MASUMI_RELEASED_LABEL,
  SCENARIOS,
} from "@pekkah/protocol";
import {
  formatAsset,
  formatLovelace,
  formatMs,
  formatSeconds,
  formatUsd,
  requestLine,
  requestWhat,
  short,
} from "./format";
import { knownScenario } from "./run";

export type Tone = "neutral" | "good" | "bad" | "info" | "warn";

export interface EventLine {
  title: string;
  detail?: string;
  tone: Tone;
  /** A Cardanoscan link, when the event has one. */
  href?: string;
}

const SOURCE_LABEL: Record<JobEvent["source"], string> = {
  agent: "My agent",
  market: "Market",
  worker: "Worker",
  chain: "Cardano",
};

export function sourceLabel(e: JobEvent): string {
  return SOURCE_LABEL[e.source];
}

/** My agent's statement about an over-budget buy: what it says, never proof (rule 2). */
export function overBudgetText(o: { budgetUsd: number; priceUsd: number }): string {
  return `My agent says I approved ${formatUsd(o.priceUsd)} (budget ${formatUsd(o.budgetUsd)}).`;
}

/** The market's own check of a delivered image, shown as its own row. */
export function checkLine(e: EventOf<"job.completed">): EventLine | undefined {
  const c = e.data.check;
  if (!c) return undefined;
  return {
    title: `The market checked the result: a PNG, ${c.width}×${c.height}`,
    detail: "It has the PNG signature and the size my agent asked for.",
    tone: "good",
  };
}

/**
 * `name(id)` turns a worker id into the name the market reports, e.g. "Worker A".
 * `seller(address)` names the worker behind a payout address, when one is listed.
 */
export function describeEvent(
  e: JobEvent,
  name: (workerId: string) => string,
  seller: (address: string) => string | undefined = () => undefined,
): EventLine {
  switch (e.type) {
    case "run.started": {
      const scenario = knownScenario(e.data.scenario);
      const r = e.data.request;
      return {
        title: e.data.client ? `${e.data.client} started a run` : "My agent started a run",
        detail: scenario ? SCENARIOS[scenario].summary : `${requestWhat(r)}. ${requestLine(r)}.`,
        tone: "info",
      };
    }
    case "quote.issued": {
      const q = e.data.quote;
      const offers = q.offers.length;
      const market = q.marketPriceUsd === null ? "no eligible worker" : formatUsd(q.marketPriceUsd);
      // The counter-offer's worker is also listed as over budget; it isn't ruled out.
      const out = q.rejected.filter((r) => r.workerId !== q.counterOffer?.workerId).length;
      return {
        title:
          offers > 0
            ? `The market answered with ${offers} offer${offers > 1 ? "s" : ""}`
            : q.counterOffer
              ? "No exact match: the market made a counter-offer"
              : "No worker can do this job",
        detail: `Market price: ${market}. ${out} worker${out === 1 ? "" : "s"} ruled out.`,
        tone: offers > 0 || q.counterOffer ? "neutral" : "warn",
      };
    }
    case "agent.decision": {
      const c = e.data.chosen;
      const who = c ? `${name(c.workerId)} at ${formatUsd(c.priceUsd)}` : "";
      if (e.data.kind === "declined")
        return { title: "My agent declined", detail: e.data.reasons.join(" "), tone: "warn" };
      return {
        title:
          e.data.kind === "counter"
            ? `My agent accepted the counter-offer: ${who}`
            : `My agent chose ${who}`,
        detail: [
          ...e.data.reasons,
          ...(e.data.overBudget ? [overBudgetText(e.data.overBudget)] : []),
        ].join(" "),
        tone: "info",
      };
    }
    case "payment.required":
      return {
        title: "402 Payment Required",
        detail:
          e.data.transferMethod === "masumi"
            ? `Lock ${formatAsset(e.data.amountAtomic)} in Masumi escrow, with ${name(e.data.workerId)} as the seller.`
            : `Pay ${formatAsset(e.data.amountAtomic)} to ${name(e.data.workerId)} (${short(e.data.payTo, 12, 6)}).`,
        tone: "neutral",
      };
    case "payment.signed":
      return {
        title: "My agent signed the payment",
        detail: `Transaction ${short(e.data.txHash)}. Signed, not sent: nothing reaches the chain until the job delivers.`,
        tone: "neutral",
      };
    case "payment.verified":
      return {
        title: "The market verified the signed payment",
        detail: "Checked, held back, not broadcast yet.",
        tone: "neutral",
      };
    case "job.dispatched":
      return {
        title: `Job sent to ${name(e.data.workerId)}`,
        detail:
          e.data.estSec !== undefined
            ? `Estimate about ${formatSeconds(e.data.estSec)}, deadline ${e.data.deadlineSec} s.`
            : `Deadline ${e.data.deadlineSec} s.`,
        tone: "neutral",
      };
    case "job.running":
      return { title: `${name(e.data.workerId)} is running the job`, tone: "info" };
    case "job.progress":
      return { title: `${Math.round(e.data.pct)}% done`, detail: e.data.note, tone: "neutral" };
    case "job.completed":
      return {
        title: `${name(e.data.workerId)} delivered the result`,
        detail: `In ${formatMs(e.data.durationMs)}. sha256 ${short(e.data.sha256, 10, 6)}.`,
        tone: "good",
      };
    case "job.failed":
      return {
        title: `The job on ${name(e.data.workerId)} failed`,
        detail: e.data.reason,
        tone: "bad",
      };
    case "payment.settling":
      return {
        title:
          e.data.transferMethod === "masumi"
            ? "Sending the escrow lock to Cardano"
            : "Sending the payment to Cardano",
        detail: "Waiting for the transaction to be included in a block.",
        tone: "neutral",
      };
    case "payment.settled":
      return {
        title:
          e.data.transferMethod === "masumi"
            ? "Locked in escrow on Cardano preprod"
            : `Settled on Cardano preprod${e.data.late ? " (late)" : ""}`,
        detail: `Transaction ${short(e.data.txHash)}.`,
        tone: "good",
        href: e.data.explorerUrl,
      };
    case "payment.canceled":
      return {
        title: "Payment cancelled: nothing was charged",
        detail: "The job didn't deliver, so the signed transaction was never sent.",
        tone: "bad",
      };
    case "payment.failed":
      return { title: "The payment failed", detail: e.data.reason, tone: "bad" };
    case "receipt.issued": {
      const r = e.data.receipt;
      return {
        title: "Receipt issued",
        detail:
          r.transferMethod === "masumi"
            ? `${formatAsset(r.amountAtomic)} locked in Masumi escrow.`
            : `${formatAsset(r.amountAtomic)} paid to the worker that ran the job.`,
        tone: "good",
        href: r.explorerUrl,
      };
    }
    case "escrow.locked": {
      const who = seller(e.data.sellerAddress) ?? short(e.data.sellerAddress, 12, 6);
      return {
        title: "Locked in Masumi escrow",
        detail: `${formatAsset(e.data.amountAtomic)} with ${who} as the seller. ${MASUMI_LOCK_LABEL}`,
        tone: "good",
        href: e.data.explorerUrl,
      };
    }
    case "escrow.result_submitted":
      return {
        title: "Result hash submitted on chain",
        detail: `The seller recorded the delivered result's hash (${short(e.data.resultHash, 10, 6)}) in the escrow. The funds stay locked in escrow until the unlock.`,
        tone: "good",
        href: e.data.explorerUrl,
      };
    case "escrow.released": {
      const who = seller(e.data.sellerAddress);
      return {
        title: who ? `Released to ${who}` : "Released to the seller",
        detail: `${formatAsset(e.data.amountAtomic)} to the seller, and the buyer's ${formatLovelace(e.data.collateralReturnLovelace)} of collateral came back. ${MASUMI_RELEASED_LABEL}`,
        tone: "good",
        href: e.data.explorerUrl,
      };
    }
    case "escrow.refunded":
      return {
        title: "Refunded to the buyer",
        detail: `${formatAsset(e.data.amountAtomic)} and ${formatLovelace(e.data.collateralReturnLovelace)} of collateral went back to the buyer. ${MASUMI_REFUNDED_LABEL}`,
        tone: "warn",
        href: e.data.explorerUrl,
      };
    case "agent.reroute":
      return {
        title: e.data.excluded.length
          ? `My agent asks again without ${e.data.excluded.map(name).join(", ")}`
          : "My agent asks again",
        detail: e.data.reason,
        tone: "warn",
      };
    case "agent.balance":
      return {
        title: "My agent's balance",
        detail: formatAsset(e.data.assetAtomic),
        tone: "neutral",
      };
    case "run.completed":
      return {
        title: "Run complete",
        detail: `${formatMs(e.data.totalMs)} in total.`,
        tone: "good",
      };
    case "run.failed":
      return { title: "Run failed", detail: e.data.reason, tone: "bad" };
    case "worker.online":
      return { title: `${e.data.name} came online`, tone: "good" };
    case "worker.offline":
      return { title: `${e.data.name} went offline`, detail: e.data.reason, tone: "warn" };
    case "worker.calibrated":
      return {
        title: `${name(e.data.workerId)} measured: ${formatSeconds(e.data.sec)}`,
        detail: e.data.verified ? "Answer checked." : "Timed, not verified.",
        tone: "neutral",
      };
    default: {
      // Every event type has its line: a new one fails to compile here until it has one.
      const unhandled: never = e;
      return unhandled;
    }
  }
}
