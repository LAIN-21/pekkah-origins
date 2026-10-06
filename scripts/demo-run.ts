// pnpm exec tsx scripts/demo-run.ts <scenario> [--runs N] [--prompt 0-4]
// pnpm exec tsx scripts/demo-run.ts --run-id <id> [--run-id <id>…]   (report only, pays nothing)
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

const USAGE = `usage: demo-run.ts <${ScenarioName.options.join("|")}> [--runs N] [--prompt 0-4] | --run-id <id>…`;

function parseCli() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        runs: { type: "string", default: "1" },
        prompt: { type: "string" },
        "run-id": { type: "string", multiple: true },
      },
    });
  } catch (err) {
    // e.g. "--runs -1": parseArgs reads -1 as an option, not a value.
    console.error(`demo-run: ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    process.exit(2);
  }
}
const { values, positionals } = parseCli();
const existing = values["run-id"] ?? [];
const scenario = ScenarioName.safeParse(positionals[0] ?? "gpu-image");
if (!scenario.success || (existing.length === 0 && positionals.length === 0)) {
  console.error(USAGE);
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

/** A GET that never throws: network and decoding failures come back as `ok: false`. */
async function getJson(
  url: string,
): Promise<{ ok: true; data: unknown } | { ok: false; why: string }> {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The run's events once it has ended. Failed reads are retried within the 15 min bound;
 * a run the market doesn't know (30 s of 404s) stops early.
 */
async function follow(runId: string): Promise<JobEvent[]> {
  let notFound = 0;
  for (let i = 0; i < 450; i++) {
    const got = await getJson(`${base}/api/runs/${runId}/events`);
    notFound = !got.ok && got.why === "HTTP 404" ? notFound + 1 : 0;
    if (notFound >= 15) throw new Error(`run ${runId} isn't known to the market`);
    const log = got.ok ? RunLog.safeParse(got.data) : null;
    if (log?.success) {
      const ended = log.data.events.some(
        (e) => e.type === "run.completed" || e.type === "run.failed",
      );
      if (ended) return log.data.events;
    }
    await sleep(2_000);
  }
  throw new Error(`run ${runId} didn't end within 15 min (or its events couldn't be read)`);
}

type ChainCheck =
  | { state: "found"; status: TxStatus }
  | { state: "not_found" }
  | { state: "unavailable"; why: string };

/** Up to 60 s: found, or not found by valid answers, or no valid answer at all. */
async function onChain(txHash: string): Promise<ChainCheck> {
  let answered = false;
  let why = "no answer";
  for (let i = 0; i < 12; i++) {
    const got = await getJson(`${base}/api/tx/${txHash}`);
    const status = got.ok ? TxStatus.safeParse(got.data) : null;
    if (status?.success) {
      answered = true;
      if (status.data.found) return { state: "found", status: status.data };
    } else {
      why = got.ok ? "unexpected answer" : got.why;
    }
    await sleep(5_000);
  }
  return answered ? { state: "not_found" } : { state: "unavailable", why };
}

/** The result bytes, with three tries; otherwise why it failed. */
async function download(url: string): Promise<{ data: Buffer; type: string } | { why: string }> {
  let why = "";
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return {
          data: Buffer.from(await res.arrayBuffer()),
          type: res.headers.get("content-type") ?? "",
        };
      }
      why = `HTTP ${res.status}`;
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    await sleep(2_000);
  }
  return { why };
}

/** Prints a finished run's evidence; returns false when it didn't settle. */
async function report(runId: string, events: JobEvent[]): Promise<boolean> {
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
    console.log(`  FAILED: ${failed?.data.reason ?? "no settlement or receipt in the events"}`);
    return false;
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
    `  on chain: ${
      chain.state === "found"
        ? `yes, block ${chain.status.block ?? "?"}, ${chain.status.confirmations ?? 0} confirmations`
        : chain.state === "not_found"
          ? "NOT FOUND within 60 s"
          : `status unavailable (${chain.why}); check the Cardanoscan link`
    }`,
  );
  if (receipt.data.resultUrl) {
    const result = await download(`${base}${receipt.data.resultUrl}`);
    if ("data" in result) {
      const file = join(out, `${runId}.${result.type.includes("png") ? "png" : "bin"}`);
      writeFileSync(file, result.data);
      console.log(`  result saved to ${file.replace(`${join(import.meta.dirname, "..")}/`, "")}`);
    } else {
      console.log(`  result: couldn't download ${receipt.data.resultUrl} (${result.why})`);
    }
  }
  const total = find(events, "run.completed")[0]?.data.totalMs;
  if (total !== undefined) console.log(`  run took ${(total / 1000).toFixed(1)} s (agent's total)`);
  return true;
}

/** Follows a run to its end and reports it; a run that can't be followed counts as a failure. */
async function followAndReport(runId: string, label: string): Promise<boolean> {
  let events: JobEvent[];
  try {
    events = await follow(runId);
  } catch (err) {
    console.log(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  console.log(`${label}: ${find(events, "run.started")[0]?.data.scenario ?? "?"}`);
  return report(runId, events);
}

mkdirSync(out, { recursive: true });
let failures = 0;
if (existing.length > 0) {
  for (const runId of existing) {
    if (!(await followAndReport(runId, `run ${runId}`))) failures += 1;
  }
} else {
  // Checked before anything is paid: a typo must not start the wrong number of runs.
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`demo-run: --runs must be a whole number of at least 1, got "${values.runs}"`);
    process.exit(2);
  }
  for (let n = 1; n <= runs; n++) {
    const runId = await start();
    if (!(await followAndReport(runId, `run ${n} (${runId})`))) failures += 1;
  }
}
process.exit(failures ? 1 : 0);
