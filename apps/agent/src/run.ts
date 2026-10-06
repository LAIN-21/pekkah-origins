import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Buyer, PaymentExpectation } from "@pekkah/buyer";
import {
  type CounterOffer,
  explorerTxUrl,
  formatUsdAtomic,
  JobResultBody,
  NETWORK,
  type Offer,
  RUN_ID_HEADER,
  SCENARIOS,
  type ScenarioName,
  scenarioRequest,
} from "@pekkah/protocol";
import { masumiEscrowAddress } from "@x402/cardano";
import type { PaymentRequirements } from "@x402/core/types";
import { decide, PRIVATE_CEILINGS_USD } from "./decide.js";
import { type EscrowReceipt, escrowLines, escrowReceipt } from "./escrow.js";
import type { MarketClient } from "./market.js";

export interface RunOptions {
  scenario: ScenarioName;
  runId: string;
  promptIndex?: number;
  buyer: Buyer;
  market: MarketClient;
  print: (line: string) => void;
  /** Where the paid result is saved, if anywhere. */
  resultsDir?: string;
  /** Where the last payment header is kept for `replay-last`. */
  lastPaymentFile?: string;
}

export interface RunOutcome {
  ok: boolean;
  reason?: string;
  jobId?: string;
  workerId?: string;
  txHash?: string;
  /** Escrow runs: what was locked in Masumi escrow. */
  escrow?: EscrowReceipt;
  totalMs: number;
}

export interface SavedPayment {
  url: string;
  paymentHeader: string;
  runId: string;
  offerId: string;
  txHash: string;
  savedAt: string;
}

const EXT: Record<string, string> = { "image/png": "png", "application/octet-stream": "bin" };
/** Answers that mean the offer can no longer be bought; the market charged nothing. */
const OFFER_GONE = new Set([404, 409, 410]);
/** Quotes per run: one failover and one re-quote at most, so a run always ends. */
const MAX_ATTEMPTS = 3;

function savePayment(file: string, saved: SavedPayment, print: (line: string) => void): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  } catch {
    print("note       could not save the payment for replay-last");
  }
}

/** One scenario, start to finish, with no human step (PLAN 4.2, 6.1). */
export async function runScenario(o: RunOptions): Promise<RunOutcome> {
  const started = Date.now();
  const ids = { runId: o.runId };
  const request = scenarioRequest(o.scenario, { promptIndex: o.promptIndex });
  const fail = async (reason: string, extra: Partial<RunOutcome> = {}): Promise<RunOutcome> => {
    o.print(`failed     ${reason}`);
    await o.market.event("run.failed", { reason }, ids);
    return { ok: false, reason, ...extra, totalMs: Date.now() - started };
  };

  o.print(`run        ${o.runId} ${o.scenario}: ${SCENARIOS[o.scenario].summary}`);
  await o.market.event("run.started", { scenario: o.scenario, request }, ids);
  const balance = await o.buyer.balance().catch(() => null);
  if (balance) await o.market.event("agent.balance", balance, ids);

  // Failover (PLAN 6.4): a failed job costs nothing; re-quote without that worker, once.
  // Escrow runs never reroute: only worker A sells through escrow.
  const excluded: string[] = [...(request.constraints.exclude ?? [])];
  const route = SCENARIOS[o.scenario].route;
  const escrow = route === "escrow-jobs";
  let paid: {
    offer: Offer | CounterOffer;
    job: JobResultBody;
    accepted?: PaymentRequirements;
    paymentHeader?: string;
  } | null = null;
  let failedOver = false;
  for (let attempt = 1; !paid; attempt += 1) {
    const attemptRequest = excluded.length
      ? { ...request, constraints: { ...request.constraints, exclude: [...excluded] } }
      : request;
    const quote = await o.market.quote(attemptRequest, o.runId);
    const decision = decide(quote, PRIVATE_CEILINGS_USD[o.scenario]);
    await o.market.event(
      "agent.decision",
      {
        kind: decision.kind,
        ...(decision.chosen ? { chosen: decision.chosen } : {}),
        reasons: decision.reasons,
      },
      ids,
    );
    for (const reason of decision.reasons) o.print(`decision   ${reason}`);
    const offer = decision.chosen;
    if (decision.kind === "declined" || !offer) return fail(decision.reasons.join(" "));

    const url = `${o.market.url}/api/${route}/${offer.offerId}`;
    // The 402 must ask for exactly what I accepted (PLAN 4.7). For escrow: locked at the escrow
    // address, the offer's worker as seller, bound to the request I just quoted.
    const expect: PaymentExpectation = escrow
      ? {
          transferMethod: "masumi",
          payTo: masumiEscrowAddress(NETWORK),
          seller: offer.payTo,
          parameters: attemptRequest,
          amountAtomic: offer.priceAtomic,
          asset: offer.asset,
        }
      : { payTo: offer.payTo, amountAtomic: offer.priceAtomic, asset: offer.asset };
    const result = await o.buyer.buy({
      url,
      headers: { [RUN_ID_HEADER]: o.runId },
      expect,
      runId: o.runId,
      offerId: offer.offerId,
    });
    if (result.paymentHeader && result.txHash && o.lastPaymentFile) {
      savePayment(
        o.lastPaymentFile,
        {
          url,
          paymentHeader: result.paymentHeader,
          runId: o.runId,
          offerId: offer.offerId,
          txHash: result.txHash,
          savedAt: new Date().toISOString(),
        },
        o.print,
      );
    }

    const body = JobResultBody.safeParse(result.body);
    if (result.status === 200 && result.settle?.success && body.success) {
      paid = {
        offer,
        job: body.data,
        ...(result.accepted ? { accepted: result.accepted } : {}),
        ...(result.paymentHeader ? { paymentHeader: result.paymentHeader } : {}),
      };
      break;
    }
    if (result.status === 502 && !failedOver && !escrow && attempt < MAX_ATTEMPTS) {
      failedOver = true;
      excluded.push(offer.workerId);
      const reason = `${offer.workerId}'s job failed and its payment was cancelled: nothing was charged. Re-quoting without ${offer.workerId}.`;
      o.print(`reroute    ${reason}`);
      await o.market.event("agent.reroute", { excluded: [...excluded], reason }, ids);
      continue;
    }
    // The offer is gone (a market restart, an expiry, someone else bought it, the worker
    // left). The market never took a payment for it, so ask again (PLAN 4.8).
    if (OFFER_GONE.has(result.status) && attempt < MAX_ATTEMPTS) {
      const reason = `The offer is no longer available (HTTP ${result.status}); nothing was charged. Re-quoting.`;
      o.print(`requote    ${reason}`);
      await o.market.event("agent.reroute", { excluded: [...excluded], reason }, ids);
      continue;
    }
    const reason =
      result.status === 502
        ? `the job failed on ${offer.workerId}; the payment was cancelled and nothing was charged`
        : result.status === 402 && result.txHash
          ? escrow
            ? "the escrow lock did not land"
            : "the payment did not settle"
          : `the market answered ${result.status}`;
    return fail(reason, { ...(result.txHash ? { txHash: result.txHash } : {}) });
  }

  const { offer } = paid;
  const job = paid.job;
  let locked: EscrowReceipt | undefined;
  if (escrow) {
    if (!paid.accepted || !paid.paymentHeader) return fail("no escrow terms for the lock");
    locked = escrowReceipt(paid.accepted, paid.paymentHeader);
    for (const line of escrowLines(locked, offer.workerId)) o.print(line);
  } else {
    o.print(
      `paid       ${formatUsdAtomic(offer.priceAtomic)} tUSDM to ${offer.workerId} (${offer.payTo})`,
    );
  }
  o.print(`tx         ${explorerTxUrl(job.txHash)}`);
  o.print(
    `job        ${job.jobId} on ${job.workerId}: ${(job.durationMs / 1000).toFixed(1)} s, sha256 ${job.sha256}`,
  );
  if (o.resultsDir) {
    // The job is paid and delivered whatever happens here; the result stays on the market.
    try {
      const data = await o.market.result(job.resultUrl);
      if (data) {
        const file = join(o.resultsDir, `${job.jobId}.${EXT[job.mime] ?? "bin"}`);
        mkdirSync(o.resultsDir, { recursive: true });
        writeFileSync(file, data);
        o.print(`result     ${file}`);
      }
    } catch (err) {
      o.print(
        `note       could not save the result (${err instanceof Error ? err.message : String(err)}); it stays at ${o.market.url}${job.resultUrl}`,
      );
    }
  }
  const totalMs = Date.now() - started;
  await o.market.event(
    "run.completed",
    { jobId: job.jobId, workerId: job.workerId, txHash: job.txHash, totalMs },
    { ...ids, jobId: job.jobId },
  );
  o.print(`done       in ${(totalMs / 1000).toFixed(1)} s`);
  return {
    ok: true,
    jobId: job.jobId,
    workerId: job.workerId,
    txHash: job.txHash,
    ...(locked ? { escrow: locked } : {}),
    totalMs,
  };
}
