import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Buyer } from "@pekkah/buyer";
import {
  explorerTxUrl,
  formatUsdAtomic,
  JobResultBody,
  RUN_ID_HEADER,
  SCENARIOS,
  type ScenarioName,
  scenarioRequest,
} from "@pekkah/protocol";
import { decide, PRIVATE_CEILINGS_USD } from "./decide.js";
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

  const quote = await o.market.quote(request, o.runId);
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

  const route = SCENARIOS[o.scenario].route;
  if (route !== "jobs") return fail(`the ${route} route arrives in PR-10`);
  const url = `${o.market.url}/api/jobs/${offer.offerId}`;
  const result = await o.buyer.buy({
    url,
    headers: { [RUN_ID_HEADER]: o.runId },
    expect: { payTo: offer.payTo, amountAtomic: offer.priceAtomic, asset: offer.asset },
    runId: o.runId,
    offerId: offer.offerId,
  });

  if (result.paymentHeader && result.txHash && o.lastPaymentFile) {
    const saved: SavedPayment = {
      url,
      paymentHeader: result.paymentHeader,
      runId: o.runId,
      offerId: offer.offerId,
      txHash: result.txHash,
      savedAt: new Date().toISOString(),
    };
    try {
      mkdirSync(dirname(o.lastPaymentFile), { recursive: true });
      writeFileSync(o.lastPaymentFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
    } catch {
      o.print("note       could not save the payment for replay-last");
    }
  }

  const body = JobResultBody.safeParse(result.body);
  if (result.status !== 200 || !result.settle?.success || !body.success) {
    const reason =
      result.status === 502
        ? `the job failed on ${offer.workerId}; the payment was cancelled and nothing was charged`
        : result.status === 402 && result.txHash
          ? "the payment did not settle"
          : `the market answered ${result.status}`;
    return fail(reason, { ...(result.txHash ? { txHash: result.txHash } : {}) });
  }

  const job = body.data;
  o.print(
    `paid       ${formatUsdAtomic(offer.priceAtomic)} tUSDM to ${offer.workerId} (${offer.payTo})`,
  );
  o.print(`tx         ${explorerTxUrl(job.txHash)}`);
  o.print(
    `job        ${job.jobId} on ${job.workerId}: ${(job.durationMs / 1000).toFixed(1)} s, sha256 ${job.sha256}`,
  );
  if (o.resultsDir) {
    const data = await o.market.result(job.resultUrl);
    if (data) {
      const file = join(o.resultsDir, `${job.jobId}.${EXT[job.mime] ?? "bin"}`);
      mkdirSync(o.resultsDir, { recursive: true });
      writeFileSync(file, data);
      o.print(`result     ${file}`);
    }
  }
  const totalMs = Date.now() - started;
  await o.market.event(
    "run.completed",
    { jobId: job.jobId, workerId: job.workerId, txHash: job.txHash, totalMs },
    { ...ids, jobId: job.jobId },
  );
  o.print(`done       in ${(totalMs / 1000).toFixed(1)} s`);
  return { ok: true, jobId: job.jobId, workerId: job.workerId, txHash: job.txHash, totalMs };
}
