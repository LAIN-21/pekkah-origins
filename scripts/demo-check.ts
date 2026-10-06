// scripts/demo-check.sh [--runs N] [--scenarios a,b] [--no-runs-md]
// The demo, end to end, against the deployed market (PLAN 9, PR-09). Every run starts through
// POST /api/demo/run with DEMO_TOKEN, so it shares the hosted agent's run lock and wallet.
// Failover kills C's job for real (scripts/chaos.sh kill-job c) once it is running. Outcomes
// come only from /api/runs/:runId/events. Cancelled transactions are then checked on chain.
// Reads PUBLIC_URL and DEMO_TOKEN from ~/.pekkah/env/market.env; prints neither.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  explorerTxUrl,
  formatUsdAtomic,
  type JobEvent,
  RunLog,
  type ScenarioName,
  type WorkerSnapshot,
} from "../packages/protocol/src/index.js";
import { loadLocalEnv } from "../packages/runtime/src/index.js";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "1" },
    scenarios: { type: "string" },
    "no-runs-md": { type: "boolean", default: false },
  },
});
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
const sgt = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(iso));

async function start(scenario: ScenarioName): Promise<string> {
  for (;;) {
    const res = await fetch(`${base}/api/demo/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ scenario }),
    });
    if (res.status === 202) return ((await res.json()) as { runId: string }).runId;
    if (res.status === 429 || res.status === 409) {
      const wait = Number(res.headers.get("retry-after") ?? "10") * 1000;
      await sleep(Math.max(wait, 5_000));
      continue;
    }
    throw new Error(`demo run refused: HTTP ${res.status} ${await res.text()}`);
  }
}

async function events(runId: string): Promise<JobEvent[]> {
  const res = await fetch(`${base}/api/runs/${runId}/events`);
  if (res.status === 404) return [];
  return RunLog.parse(await res.json()).events;
}

/** Waits for the run to end; for failover, kills C's job once it runs. */
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
    if (list.some((e) => e.type === "run.completed" || e.type === "run.failed")) return list;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not end within 12 minutes`);
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

const canceled: { txHash: string; ttlSlot?: string }[] = [];

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
const rounds = Number(values.runs);
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

console.log("\ncancelled payments on chain:");
let chainOk = true;
for (const c of canceled) {
  const q = c.ttlSlot ? `?ttlSlot=${c.ttlSlot}` : "";
  const status = (await (await fetch(`${base}/api/tx/${c.txHash}${q}`)).json()) as {
    found: boolean;
    final?: boolean;
  };
  if (status.found) chainOk = false;
  console.log(
    `  ${c.txHash} found=${status.found}${status.final === undefined ? "" : ` final=${status.final}`}`,
  );
}

console.log("");
const passed = rows.filter((r) => r.pass).length;
for (const r of rows) {
  console.log(
    `${r.pass ? "PASS" : "FAIL"}  ${r.scenario.padEnd(12)} ${(r.workerId ?? "-").padEnd(3)} ${(r.amountAtomic ? formatUsdAtomic(r.amountAtomic) : "-").padEnd(7)} ${r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)} s` : ""}`,
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
  if (!existsSync(file)) {
    writeFileSync(
      file,
      "# Runs\n\nReal runs on Cardano preprod, appended by `scripts/demo-check.sh`.\n\n| Time (SGT) | Scenario | Worker | Price | Tx | Duration | sha256 |\n| --- | --- | --- | --- | --- | --- | --- |\n",
    );
  }
  for (const r of rows.filter((x) => x.pass && x.txHash)) {
    appendFileSync(
      file,
      `| ${sgt(r.at)} | ${r.scenario} | ${r.workerId} | ${formatUsdAtomic(r.amountAtomic ?? "0")} | [${r.txHash?.slice(0, 10)}…](${explorerTxUrl(r.txHash ?? "")}) | ${((r.durationMs ?? 0) / 1000).toFixed(1)} s | \`${r.sha256?.slice(0, 16)}\` |\n`,
    );
  }
  console.log(`appended ${rows.filter((x) => x.pass).length} rows to docs/RUNS.md`);
}
process.exit(fullRounds === rounds && chainOk ? 0 : 1);
