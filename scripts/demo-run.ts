// pnpm exec tsx scripts/demo-run.ts <scenario> [--runs N] [--prompt 0-4]
// Real paid runs on the deployed market, started through its own run route
// (POST /api/demo/run with DEMO_TOKEN). They go through the hosted agent and its
// one-run-at-a-time lock, so they never overlap another paid run on the same
// wallet. Follows each run's events to the end, then prints the worker, the amount,
// the settlement tx with its Cardanoscan link and whether the chain shows it, and
// saves the result to results/demo-run/. Reads PUBLIC_URL and DEMO_TOKEN through
// the app's env loader; prints neither.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type EventOf,
  formatUsdAtomic,
  type JobEvent,
  RunLog,
  ScenarioName,
  TxStatus,
} from "../packages/protocol/src/index.js";
import { loadLocalEnv } from "../packages/runtime/src/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: "string", default: "1" }, prompt: { type: "string" } },
});
const scenario = ScenarioName.safeParse(positionals[0]);
if (!scenario.success) {
  console.error(`usage: demo-run.ts <${ScenarioName.options.join("|")}> [--runs N] [--prompt 0-4]`);
  process.exit(2);
}
process.env.PEKKAH_ENV_FILE ||= join(homedir(), ".pekkah", "env", "market.env");
loadLocalEnv();
const base = process.env.PUBLIC_URL?.replace(/\/+$/, "");
const token = process.env.DEMO_TOKEN;
if (!base || !token) {
  console.error("demo-run: market.env needs PUBLIC_URL and DEMO_TOKEN");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = join(import.meta.dirname, "..", "results", "demo-run");
const find = <T extends JobEvent["type"]>(events: JobEvent[], type: T) =>
  events.filter((e): e is EventOf<T> => e.type === type);

async function start(): Promise<string> {
  // Another run holds the lock, or the market is restarting: wait, never run alongside.
  for (let waited = 0; waited < 900_000; waited += 5_000) {
    let status = 0;
    let body: { runId?: string; error?: string } = {};
    try {
      const res = await fetch(`${base}/api/demo/run`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          scenario: scenario.data,
          ...(values.prompt !== undefined ? { promptIndex: Number(values.prompt) } : {}),
        }),
      });
      status = res.status;
      body = (await res.json().catch(() => ({}))) as typeof body;
    } catch {
      status = 0;
    }
    if (status === 202 && body.runId) return body.runId;
    const transient = status === 0 || status === 409 || status === 429 || status >= 502;
    if (!transient) throw new Error(`the market answered ${status}: ${body.error ?? "?"}`);
    if (waited === 0) {
      console.log(
        `  waiting: ${body.error ?? (status ? `HTTP ${status}` : "market unreachable")}, retrying every 5 s`,
      );
    }
    await sleep(5_000);
  }
  throw new Error("gave up waiting for the market after 15 min");
}

async function follow(runId: string): Promise<JobEvent[]> {
  for (let i = 0; i < 450; i++) {
    const res = await fetch(`${base}/api/runs/${runId}/events`);
    if (res.ok) {
      const log = RunLog.parse(await res.json());
      if (log.events.some((e) => e.type === "run.completed" || e.type === "run.failed")) {
        return log.events;
      }
    }
    await sleep(2_000);
  }
  throw new Error(`run ${runId} didn't end within 15 min`);
}

async function onChain(txHash: string): Promise<TxStatus | null> {
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${base}/api/tx/${txHash}`);
    if (res.ok) {
      const status = TxStatus.parse(await res.json());
      if (status.found) return status;
    }
    await sleep(5_000);
  }
  return null;
}

mkdirSync(out, { recursive: true });
let failures = 0;
for (let n = 1; n <= Number(values.runs); n++) {
  const started = Date.now();
  const runId = await start();
  console.log(`run ${n}: ${scenario.data}, runId ${runId}`);
  const events = await follow(runId);
  const failed = find(events, "run.failed")[0];
  const decision = find(events, "agent.decision").at(-1);
  const verified = find(events, "payment.verified").at(-1);
  const settled = find(events, "payment.settled").at(-1);
  const receipt = find(events, "receipt.issued").at(-1);
  const completed = find(events, "job.completed").at(-1);
  const canceled = find(events, "payment.canceled");
  console.log(
    `  decision ${decision?.data.kind ?? "-"}: ${decision?.data.chosen?.workerId ?? "-"}` +
      `${decision?.data.chosen ? ` at $${decision.data.chosen.priceUsd}` : ""}`,
  );
  for (const c of canceled) {
    console.log(`  cancelled: ${c.data.reason} (nothing charged for ${c.data.txHash ?? "-"})`);
  }
  if (failed || !settled || !receipt) {
    failures += 1;
    console.log(`  FAILED: ${failed?.data.reason ?? "no settlement or receipt in the events"}`);
    continue;
  }
  const r = receipt.data.receipt;
  console.log(
    `  paid ${formatUsdAtomic(r.amountAtomic)} tUSDM to ${verified?.data.workerId ?? "?"} (${r.payTo})`,
  );
  console.log(
    `  job ${completed?.data.durationMs ?? "?"} ms on ${completed?.data.workerId ?? "?"}, sha256 ${completed?.data.sha256 ?? "?"}`,
  );
  console.log(`  tx  ${settled.data.explorerUrl}`);
  const chain = await onChain(r.txHash);
  console.log(
    `  on chain: ${chain ? `yes, block ${chain.block ?? "?"}, ${chain.confirmations ?? 0} confirmations` : "NOT FOUND within 60 s"}`,
  );
  if (receipt.data.resultUrl) {
    const res = await fetch(`${base}${receipt.data.resultUrl}`);
    if (res.ok) {
      const ext = (res.headers.get("content-type") ?? "").includes("png") ? "png" : "bin";
      const file = join(out, `${runId}.${ext}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      console.log(`  result saved to ${file.replace(`${join(import.meta.dirname, "..")}/`, "")}`);
    } else {
      console.log(`  result: ${res.status} from ${receipt.data.resultUrl}`);
    }
  }
  console.log(`  run took ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
process.exit(failures ? 1 : 0);
