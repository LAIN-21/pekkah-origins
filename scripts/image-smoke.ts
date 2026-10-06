// pnpm exec tsx scripts/image-smoke.ts [--worker A] [--runs 1]
// PR-07b on the deployed market: shows the worker's image calibration, dev-dispatches image
// jobs to it (unpaid, dev: true), samples its GPU utilisation from /api/workers while each
// runs, saves the PNGs to results/image-smoke/ and checks their sha256. Reads PUBLIC_URL and
// DEMO_TOKEN from ~/.pekkah/env/market.env through the app's env loader; prints neither.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  IMAGE_PROMPTS,
  type ImageParams,
  type WorkerSnapshot,
} from "../packages/protocol/src/index.js";
import { loadLocalEnv } from "../packages/runtime/src/index.js";

const { values } = parseArgs({
  options: { worker: { type: "string", default: "A" }, runs: { type: "string", default: "1" } },
});
process.env.PEKKAH_ENV_FILE ||= join(homedir(), ".pekkah", "env", "market.env");
loadLocalEnv();
const base = process.env.PUBLIC_URL?.replace(/\/+$/, "");
const token = process.env.DEMO_TOKEN;
if (!base || !token) {
  console.error("image-smoke: market.env needs PUBLIC_URL and DEMO_TOKEN");
  process.exit(1);
}
const workerId = values.worker ?? "A";
const auth = { authorization: `Bearer ${token}` };

async function worker(): Promise<WorkerSnapshot | undefined> {
  const res = await fetch(`${base}/api/workers`);
  const all = (await res.json()) as WorkerSnapshot[];
  return all.find((w) => w.workerId === workerId);
}

const before = await worker();
if (!before) {
  console.error(`image-smoke: worker ${workerId} is not connected to ${base}`);
  process.exit(1);
}
console.log(
  `${workerId}: ${before.status}, warm [${before.warm.join(", ")}], GPU ${before.hardware.gpu?.name ?? "none"}`,
);
console.log(`image calibration: ${JSON.stringify(before.calibration.image ?? null)}`);
if (!before.warm.includes("image")) {
  console.error(`image-smoke: ${workerId} doesn't offer image (flux not ready?)`);
  process.exit(1);
}

const out = join(import.meta.dirname, "..", "results", "image-smoke");
mkdirSync(out, { recursive: true });

for (let i = 0; i < Number(values.runs); i++) {
  const params: ImageParams = {
    prompt: IMAGE_PROMPTS[i % IMAGE_PROMPTS.length] as string,
    seed: 100 + i,
    size: 1024,
    steps: 4,
  };
  const samples: { status: string; gpuPct?: number; vramUsedGb?: number }[] = [];
  const sampler = setInterval(async () => {
    const w = await worker().catch(() => undefined);
    if (w)
      samples.push({ status: w.status, gpuPct: w.util?.gpuPct, vramUsedGb: w.util?.vramUsedGb });
  }, 500);
  const started = Date.now();
  const res = await fetch(`${base}/api/dev/dispatch`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ workerId, workload: "image", params }),
  });
  clearInterval(sampler);
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`run ${i + 1}: ${res.status} ${JSON.stringify(body)}`);
    process.exit(1);
  }
  const png = Buffer.from(
    await (await fetch(`${base}${String(body.resultUrl)}`, { headers: auth })).arrayBuffer(),
  );
  const sha256 = createHash("sha256").update(png).digest("hex");
  const file = join(out, `image-${i + 1}.png`);
  writeFileSync(file, png);
  const busy = samples.filter((s) => s.status === "busy");
  const peakGpu = Math.max(0, ...samples.map((s) => s.gpuPct ?? 0));
  console.log(
    `run ${i + 1}: ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)} s ` +
      `(worker ${Number(body.workerDurationMs) / 1000} s), ${png.length} bytes, sha256 ${sha256} ` +
      `(${sha256 === body.sha256 ? "matches" : "DIFFERS from"} the market's)`,
  );
  console.log(
    `  /api/workers during the job: ${samples.length} samples, ${busy.length} busy, ` +
      `peak GPU ${peakGpu}%, GPU % seen: ${samples.map((s) => s.gpuPct ?? "-").join(" ")}`,
  );
  console.log(`  saved ${file.replace(`${join(import.meta.dirname, "..")}/`, "")}`);
}
