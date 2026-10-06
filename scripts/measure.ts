// pnpm measure [--workers B,C] [--presets hd-fast,hd-heavy]
// PR-05 tuning on real hardware: dev-dispatches each preset to each calibrated worker on the
// deployed market, then prints the matcher's estimate next to the market-measured time and
// checks PLAN 6.3's rule for hd-heavy. Reads PUBLIC_URL and DEMO_TOKEN from
// ~/.pekkah/env/market.env through the app's env loader; prints neither.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { estimateSec } from "../packages/matcher/src/index.js";
import { scenarioRequest, type WorkerSnapshot } from "../packages/protocol/src/index.js";
import { loadLocalEnv } from "../packages/runtime/src/index.js";

const { values } = parseArgs({
  options: { workers: { type: "string" }, presets: { type: "string" } },
});
process.env.PEKKAH_ENV_FILE ||= join(homedir(), ".pekkah", "env", "market.env");
loadLocalEnv();
const base = process.env.PUBLIC_URL?.replace(/\/+$/, "");
const token = process.env.DEMO_TOKEN;
if (!base || !token) {
  console.error("measure: market.env needs PUBLIC_URL and DEMO_TOKEN");
  process.exit(1);
}
const presets = (values.presets ?? "hd-fast,hd-heavy").split(",");
const wanted = values.workers?.split(",");

const workers = (await (await fetch(`${base}/api/workers`)).json()) as WorkerSnapshot[];
const rows: string[][] = [["worker", "preset", "est s", "actual s", "actual/est"]];
const est: Record<string, number> = {};
for (const w of workers) {
  if (wanted && !wanted.includes(w.workerId)) continue;
  if (w.status !== "online" || !w.calibration.fractal) {
    console.log(`skip ${w.workerId}: ${w.status}, calibrated ${!!w.calibration.fractal}`);
    continue;
  }
  for (const preset of presets) {
    const request = scenarioRequest(preset === "hd-fast" ? "cpu-counter" : "cpu-tight");
    if (request.workload !== "fractal") continue;
    request.params.preset = preset as typeof request.params.preset;
    const estimate = estimateSec(request, w) ?? Number.NaN;
    const res = await fetch(`${base}/api/dev/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ workerId: w.workerId, workload: "fractal", params: request.params }),
    });
    const body = (await res.json()) as { durationMs?: number; sha256?: string; error?: string };
    if (!res.ok || body.durationMs === undefined) {
      console.log(`${w.workerId} ${preset}: HTTP ${res.status} ${body.error ?? ""}`);
      continue;
    }
    const actual = body.durationMs / 1000;
    est[`${w.workerId}:${preset}`] = estimate;
    rows.push([
      w.workerId,
      preset,
      estimate.toFixed(1),
      actual.toFixed(1),
      (actual / estimate).toFixed(2),
    ]);
    console.log(
      `${w.workerId} ${preset}: est ${estimate.toFixed(1)} s, actual ${actual.toFixed(1)} s, sha256 ${body.sha256?.slice(0, 16)}`,
    );
  }
}
console.log("");
for (const row of rows) console.log(row.map((c) => c.padEnd(11)).join(""));
const h = (id: string) => est[`${id}:hd-heavy`];
const rule: [string, number | undefined, (v: number) => boolean][] = [
  ["est(B) <= 12 s", h("B"), (v) => v <= 12],
  ["est(A) <= 16 s", h("A"), (v) => v <= 16],
  ["est(C) >= 30 s", h("C"), (v) => v >= 30],
  ["est(C) <= 96 s", h("C"), (v) => v <= 96],
];
console.log("\nhd-heavy tuning rule (PLAN 6.3):");
for (const [name, value, ok] of rule) {
  console.log(
    `  ${name.padEnd(16)} ${value === undefined ? "not measured" : `${value.toFixed(1)} s  ${ok(value) ? "ok" : "FAILS"}`}`,
  );
}
