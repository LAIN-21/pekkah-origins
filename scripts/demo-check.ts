// scripts/demo-check.sh [--runs N] [--scenarios a,b] [--escrow] [--no-runs-md]
// The demo, end to end, against the deployed market (PLAN 9, PR-09). Every run starts through
// POST /api/demo/run with DEMO_TOKEN, so it shares the hosted agent's run lock and wallet.
// Failover kills C's job for real (scripts/chaos.sh kill-job c) once it is running. Outcomes
// come only from /api/runs/:runId/events. Cancelled transactions are then checked on chain.
// --escrow (PR-10) adds one Masumi escrow run at the end, never inside the rounds (locked funds
// stay locked), checks the Masumi minimum (PLAN 4.9) and writes the evidence block (12.3).
// --runs 0 --escrow runs only that. Reads PUBLIC_URL and DEMO_TOKEN from
// ~/.pekkah/env/market.env; prints neither.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parametersInputHash } from "../packages/payments/src/server.js";
import {
  type EscrowLock,
  explorerTxUrl,
  formatAtomic,
  formatLovelace,
  formatUsdAtomic,
  type JobEvent,
  MASUMI_LOCK_LABEL,
  RunLog,
  type ScenarioName,
  type WorkerSnapshot,
} from "../packages/protocol/src/index.js";
import { loadLocalEnv } from "../packages/runtime/src/index.js";
import { updateRunsMd } from "./runs-md.js";

/** Masumi's vested_pay V2 escrow on preprod (PLAN 4.8): the escrow route's payTo. */
const MASUMI_ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "1" },
    scenarios: { type: "string" },
    escrow: { type: "boolean", default: false },
    "no-runs-md": { type: "boolean", default: false },
  },
});
const rounds = Number(values.runs);
// --runs 0 only makes sense with --escrow: the escrow run alone.
if (!Number.isInteger(rounds) || rounds < (values.escrow ? 0 : 1)) {
  console.error("demo-check: --runs takes a positive integer, or 0 with --escrow");
  process.exit(2);
}
process.env.PEKKAH_ENV_FILE ||= join(homedir(), ".pekkah", "env", "market.env");
loadLocalEnv();
const base = process.env.PUBLIC_URL?.replace(/\/+$/, "");
const token = process.env.DEMO_TOKEN;
if (!base || !token) {
  console.error("demo-check: market.env needs PUBLIC_URL and DEMO_TOKEN");
  process.exit(1);
}

interface Expect {
  workerId: string;
  amountAtomic: string;
  failover?: boolean;
}
const EXPECT: Partial<Record<ScenarioName, Expect>> = {
  "gpu-image": { workerId: "A", amountAtomic: "50000" },
  "cpu-counter": { workerId: "C", amountAtomic: "20000" },
  "cpu-tight": { workerId: "B", amountAtomic: "30000" },
  failover: { workerId: "B", amountAtomic: "30000", failover: true },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ISO date and time in Singapore, e.g. 2026-10-06 16:12:11: no day/month ambiguity. */
const sgt = (iso: string) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Singapore",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(iso));

/** Starts a run, waiting out a run in progress or the rate limit, for 5 minutes at most. */
async function start(scenario: ScenarioName): Promise<string> {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const res = await fetch(`${base}/api/demo/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ scenario }),
    });
    if (res.status === 202) return ((await res.json()) as { runId: string }).runId;
    const answer = `HTTP ${res.status} ${await res.text()}`;
    if ((res.status === 429 || res.status === 409) && Date.now() < deadline) {
      const wait = Number(res.headers.get("retry-after") ?? "10") * 1000;
      await sleep(Math.max(wait, 5_000));
      continue;
    }
    throw new Error(`demo run refused: ${answer}`);
  }
}

async function events(runId: string): Promise<JobEvent[]> {
  const res = await fetch(`${base}/api/runs/${runId}/events`);
  if (res.status === 404) return [];
  return RunLog.parse(await res.json()).events;
}

/**
 * Waits for the run to end, and for a completed run also for its payment.settled and
 * receipt.issued (a late settlement sends them after the run ends). For failover, kills C's
 * job once it runs.
 */
async function follow(runId: string, killC: boolean): Promise<JobEvent[]> {
  const deadline = Date.now() + 12 * 60_000;
  let killed = false;
  for (;;) {
    const list = await events(runId);
    if (killC && !killed) {
      const running = list.find((e) => e.type === "job.running" && e.data.workerId === "C");
      if (running) {
        await sleep(3_000);
        const out = spawnSync(join(root, "scripts/chaos.sh"), ["kill-job", "c"], {
          encoding: "utf8",
        });
        console.log(`  chaos: ${(out.stdout || out.stderr).trim()}`);
        killed = true;
      }
    }
    if (list.some((e) => e.type === "run.failed")) return list;
    const done = list.find((e) => e.type === "run.completed");
    if (done?.type === "run.completed") {
      const tx = done.data.txHash;
      const settled = list.some((e) => e.type === "payment.settled" && e.data.txHash === tx);
      const receipt = list.some((e) => e.type === "receipt.issued" && e.data.receipt.txHash === tx);
      // At the deadline, check() names whatever is still missing.
      if ((settled && receipt) || Date.now() > deadline) return list;
    } else if (Date.now() > deadline) {
      throw new Error(`run ${runId} did not end within 12 minutes`);
    }
    await sleep(2_000);
  }
}

interface Row {
  at: string;
  scenario: ScenarioName;
  pass: boolean;
  why: string[];
  workerId?: string;
  amountAtomic?: string;
  txHash?: string;
  durationMs?: number;
  sha256?: string;
}

/** Each cancelled payment, with the run it belongs to: that run passes only if it stays off chain. */
const canceled: { txHash: string; ttlSlot?: string; row: Row }[] = [];

async function check(scenario: ScenarioName, list: JobEvent[]): Promise<Row> {
  const expect = EXPECT[scenario];
  const why: string[] = [];
  const first = list[0];
  const row: Row = { at: first?.ts ?? new Date().toISOString(), scenario, pass: false, why };
  const done = list.find((e) => e.type === "run.completed");
  const failed = list.find((e) => e.type === "run.failed");
  if (done?.type !== "run.completed") {
    why.push(`run failed: ${failed?.type === "run.failed" ? failed.data.reason : "no end event"}`);
    return row;
  }
  row.workerId = done.data.workerId;
  row.txHash = done.data.txHash;
  const settled = list.find(
    (e) => e.type === "payment.settled" && e.data.txHash === done.data.txHash,
  );
  const receipt = list.find(
    (e) => e.type === "receipt.issued" && e.data.receipt.txHash === done.data.txHash,
  );
  const completed = list.find((e) => e.type === "job.completed" && e.jobId === done.data.jobId);
  if (!settled) why.push("no payment.settled for the paid tx");
  if (receipt?.type === "receipt.issued") {
    row.amountAtomic = receipt.data.receipt.amountAtomic;
    const result = await fetch(`${base}${receipt.data.resultUrl}`);
    if (result.status !== 200) why.push(`result not readable (HTTP ${result.status})`);
  } else why.push("no receipt.issued");
  if (completed?.type === "job.completed") {
    row.durationMs = completed.data.durationMs;
    row.sha256 = completed.data.sha256;
  }
  if (expect) {
    if (row.workerId !== expect.workerId)
      why.push(`paid ${row.workerId}, expected ${expect.workerId}`);
    if (row.amountAtomic !== expect.amountAtomic) {
      why.push(`amount ${row.amountAtomic}, expected ${expect.amountAtomic}`);
    }
  }
  const signed = list.filter((e) => e.type === "payment.signed");
  for (const e of list) {
    if (e.type !== "payment.canceled" || !e.data.txHash) continue;
    const s = signed.find((x) => x.type === "payment.signed" && x.data.txHash === e.data.txHash);
    canceled.push({
      row,
      txHash: e.data.txHash,
      ...(s?.type === "payment.signed" && s.data.ttlSlot ? { ttlSlot: s.data.ttlSlot } : {}),
    });
  }
  if (expect?.failover) {
    if (!list.some((e) => e.type === "payment.canceled")) why.push("no cancelled payment");
    if (!list.some((e) => e.type === "agent.reroute")) why.push("no reroute");
  }
  row.pass = why.length === 0;
  return row;
}

interface EscrowCheck {
  pass: boolean;
  why: string[];
  block?: string;
}

const deadline = (posixMs: string) => sgt(new Date(Number(posixMs)).toISOString());
const hardware = (w: WorkerSnapshot | undefined) =>
  w
    ? [
        w.hardware.gpu ? `${w.hardware.gpu.name} ${w.hardware.gpu.vramGb} GB` : null,
        `${w.hardware.vcpus} vCPU ${w.hardware.cpuModel}`,
        `${w.hardware.memGb} GB RAM`,
      ]
        .filter(Boolean)
        .join(", ")
    : "unknown hardware";

/** The Masumi minimum (PLAN 4.9), checked only from the run's events and the chain. */
async function checkEscrow(
  scenario: ScenarioName,
  runId: string,
  list: JobEvent[],
  workers: WorkerSnapshot[],
): Promise<EscrowCheck> {
  const why: string[] = [];
  const done = list.find((e) => e.type === "run.completed");
  if (done?.type !== "run.completed") {
    const failed = list.find((e) => e.type === "run.failed");
    why.push(`run failed: ${failed?.type === "run.failed" ? failed.data.reason : "no end event"}`);
    return { pass: false, why };
  }
  const { txHash, jobId, workerId } = done.data;
  const of = <T extends JobEvent["type"]>(
    type: T,
    match: (e: Extract<JobEvent, { type: T }>) => boolean,
  ) => list.find((e): e is Extract<JobEvent, { type: T }> => e.type === type && match(e as never));
  const started = of("run.started", () => true);
  const decision = of("agent.decision", () => true);
  const signed = of("payment.signed", (e) => e.data.txHash === txHash);
  const completed = of("job.completed", (e) => e.jobId === jobId);
  const settled = of("payment.settled", (e) => e.data.txHash === txHash);
  const locked = of("escrow.locked", (e) => e.data.txHash === txHash);
  const receipt = of("receipt.issued", (e) => e.data.receipt.txHash === txHash);

  // 1. Autonomous: my agent started, decided and signed, with no human step.
  if (started?.source !== "agent" || decision?.source !== "agent" || signed?.source !== "agent") {
    why.push("1: the agent did not start, decide and sign the run itself");
  }
  if (signed?.data.transferMethod !== "masumi") why.push("1: the agent did not sign a Masumi lock");
  // 2. Real compute, delivered; the lock was broadcast only after delivery.
  if (!completed) why.push("2: no job.completed for the run's job");
  if (settled?.data.transferMethod !== "masumi") why.push("2/3: no Masumi lock settled");
  if (completed && settled && completed.id > settled.id)
    why.push("2: the lock landed before delivery");
  if (receipt) {
    const result = await fetch(`${base}${receipt.data.resultUrl}`);
    if (result.status !== 200) why.push(`2: result not readable (HTTP ${result.status})`);
    if (receipt.data.receipt.transferMethod !== "masumi") why.push("2: the receipt is not masumi");
  } else why.push("2: no receipt.issued");
  // 3. A real lock at Masumi's escrow, on chain.
  if (!locked) why.push("3: no escrow.locked");
  if (locked && locked.data.escrowAddress !== MASUMI_ESCROW) {
    why.push(`3: escrow address ${locked.data.escrowAddress} is not Masumi's vested_pay V2`);
  }
  const chain = (await (await fetch(`${base}/api/tx/${txHash}`)).json()) as { found?: boolean };
  if (!chain.found) why.push("3: the lock transaction is not on chain");
  // 4. The selected worker is the seller.
  const worker = workers.find((w) => w.workerId === workerId);
  const chosen = decision?.data.chosen;
  if (chosen?.workerId !== workerId)
    why.push(`4: the agent chose ${chosen?.workerId}, ${workerId} ran`);
  if (locked && locked.data.sellerAddress !== worker?.payTo) {
    why.push(`4: the seller ${locked.data.sellerAddress} is not worker ${workerId}'s address`);
  }
  // 5. Bound to the request: recompute the commitment from the request my agent quoted.
  const requestHash = started ? parametersInputHash(started.data.request) : null;
  if (locked && requestHash !== locked.data.inputHash) {
    why.push("5: terms.inputHash is not the commitment to the quoted request");
  }
  if (!locked || !started || !completed) return { pass: false, why };

  // 6. Visible: the evidence block (12.3).
  const l: EscrowLock = locked.data;
  const block = [
    `### Masumi evidence: ${scenario}, ${sgt(started.ts)} SGT`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Run | \`${scenario}\`, run \`${runId}\`, ${sgt(started.ts)} SGT |`,
    `| Compute | worker ${workerId} (${hardware(worker)}), ${started.data.request.workload}, ${(completed.data.durationMs / 1000).toFixed(1)} s, sha256 \`${completed.data.sha256}\` |`,
    `| Lock tx | [\`${txHash}\`](${explorerTxUrl(txHash)}) |`,
    `| Escrow address | \`${l.escrowAddress}\` (Masumi \`vested_pay\` V2, preprod) |`,
    `| Seller | worker ${workerId}, \`${l.sellerAddress}\` (\`terms.sellerAddress\`) |`,
    `| Request hash | \`${l.inputHash}\` (\`terms.inputHash\`; recomputed from the quoted request: ${requestHash === l.inputHash ? "match" : "MISMATCH"}) |`,
    `| Amount and asset | ${formatAtomic(l.amountAtomic)} tUSDM (\`${l.asset}\`) plus ${formatLovelace(l.collateralLovelace)} collateral |`,
    `| Inline datum and deadlines | inline datum on the escrow output ([check on Cardanoscan](${explorerTxUrl(txHash)})); pay by ${deadline(l.payByTime)}, submit result ${deadline(l.submitResultTime)}, unlock ${deadline(l.unlockTime)}, dispute ${deadline(l.externalDisputeUnlockTime)} (SGT) |`,
    `| Status | ${MASUMI_LOCK_LABEL} |`,
    "",
  ].join("\n");
  return { pass: why.length === 0, why, block };
}

const workers = (await (await fetch(`${base}/api/workers`)).json()) as WorkerSnapshot[];
const imageReady = workers.some((w) => w.status !== "offline" && w.warm.includes("image"));
const scenarios = (values.scenarios?.split(",") as ScenarioName[] | undefined) ?? [
  ...(imageReady ? (["gpu-image"] as const) : []),
  "cpu-counter",
  "cpu-tight",
  "failover",
];
if (!imageReady && !values.scenarios)
  console.log("note: no worker offers image yet; skipping gpu-image");

const rows: Row[] = [];
for (let round = 1; round <= rounds; round++) {
  for (const scenario of scenarios) {
    const runId = await start(scenario);
    console.log(`round ${round} ${scenario}: run ${runId}`);
    const row = await check(scenario, await follow(runId, scenario === "failover"));
    rows.push(row);
    console.log(
      `  ${row.pass ? "PASS" : "FAIL"} ${row.workerId ?? "-"} ${row.amountAtomic ? formatUsdAtomic(row.amountAtomic) : ""} ${row.txHash ? explorerTxUrl(row.txHash) : ""} ${row.why.join("; ")}`,
    );
  }
}

let escrow: EscrowCheck | null = null;
if (values.escrow) {
  // gpu-image-escrow when worker A serves images; otherwise fractal-escrow on A (PLAN 4.9).
  const a = workers.find((w) => w.workerId === "A");
  const scenario: ScenarioName =
    a && a.status !== "offline" && a.warm.includes("image") ? "gpu-image-escrow" : "fractal-escrow";
  const runId = await start(scenario);
  console.log(`escrow ${scenario}: run ${runId}`);
  escrow = await checkEscrow(scenario, runId, await follow(runId, false), workers);
  console.log(`  ${escrow.pass ? "PASS" : "FAIL"} ${escrow.why.join("; ")}`);
  if (escrow.block) console.log(`\n${escrow.block}`);
}

// A cancelled payment passes only once the chain is past its TTL slot and it is still absent
// (found:false, final:true): from then on it can never land. Absence alone could change.
console.log("\ncancelled payments on chain (waiting until each one is past its TTL):");
let chainOk = true;
const refuse = (c: (typeof canceled)[number], why: string) => {
  chainOk = false;
  c.row.pass = false;
  c.row.why.push(`cancelled tx ${c.txHash} ${why}`);
  console.log(`  ${c.txHash} ${why}`);
};
for (const c of canceled) {
  if (!c.ttlSlot) {
    refuse(c, "has no TTL slot, so it cannot be proven final");
    continue;
  }
  const until = Date.now() + 12 * 60_000;
  for (;;) {
    const res = await fetch(`${base}/api/tx/${c.txHash}?ttlSlot=${c.ttlSlot}`).catch(() => null);
    const status = (await res?.json().catch(() => null)) as { found?: unknown; final?: unknown };
    if (!res?.ok || typeof status?.found !== "boolean") {
      refuse(c, `could not be checked (HTTP ${res?.status ?? "-"})`);
      break;
    }
    if (status.found) {
      refuse(c, "is on chain");
      break;
    }
    if (status.final === true) {
      console.log(`  ${c.txHash} found=false final=true`);
      break;
    }
    if (Date.now() > until) {
      refuse(c, "is still not past its TTL after 12 minutes");
      break;
    }
    await sleep(15_000);
  }
}

console.log("");
const passed = rows.filter((r) => r.pass).length;
for (const r of rows) {
  console.log(
    `${r.pass ? "PASS" : "FAIL"}  ${r.scenario.padEnd(12)} ${(r.workerId ?? "-").padEnd(3)} ${(r.amountAtomic ? formatUsdAtomic(r.amountAtomic) : "-").padEnd(7)} ${r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)} s` : ""} ${r.pass ? "" : r.why.join("; ")}`.trimEnd(),
  );
}
const perRound = scenarios.length;
const fullRounds = Array.from({ length: rounds }, (_, i) =>
  rows.slice(i * perRound, (i + 1) * perRound),
).filter((r) => r.length === perRound && r.every((x) => x.pass)).length;
console.log(
  `\n${fullRounds}/${rounds} rounds PASS (${passed}/${rows.length} runs); cancelled txs absent on chain: ${chainOk ? "yes" : "NO"}`,
);

if (!values["no-runs-md"]) {
  const file = join(root, "docs/RUNS.md");
  const added = rows.filter((x) => x.pass && x.txHash);
  const block = escrow?.pass ? escrow.block : undefined;
  writeFileSync(
    file,
    updateRunsMd(
      existsSync(file) ? readFileSync(file, "utf8") : null,
      added.map(
        (r) =>
          `| ${sgt(r.at)} | ${r.scenario} | ${r.workerId} | ${formatUsdAtomic(r.amountAtomic ?? "0")} | [${r.txHash?.slice(0, 10)}…](${explorerTxUrl(r.txHash ?? "")}) | ${((r.durationMs ?? 0) / 1000).toFixed(1)} s | \`${r.sha256}\` |`,
      ),
      block,
    ),
  );
  console.log(
    `docs/RUNS.md: ${added.length} rows${block ? ", and the Masumi evidence block" : ""}`,
  );
}
process.exit(fullRounds === rounds && chainOk && (escrow?.pass ?? true) ? 0 : 1);
