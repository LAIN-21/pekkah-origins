import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { GpuInfo, WorkerHardware, WorkerUtil } from "@pekkah/protocol";

const run = promisify(execFile);
const round1 = (n: number) => Math.round(n * 10) / 10;

async function nvidiaSmi(query: string): Promise<string[] | null> {
  try {
    const { stdout } = await run(
      "nvidia-smi",
      [`--query-gpu=${query}`, "--format=csv,noheader,nounits"],
      {
        timeout: 5_000,
      },
    );
    const line = stdout.trim().split("\n")[0];
    return line ? line.split(",").map((s) => s.trim()) : null;
  } catch {
    return null;
  }
}

export async function detectGpu(): Promise<GpuInfo | undefined> {
  const row = await nvidiaSmi("name,memory.total,driver_version");
  if (!row) return undefined;
  const [name, memMiB, driver] = row;
  if (!name || !memMiB) return undefined;
  return { name, vramGb: round1(Number(memMiB) / 1024), driver: driver ?? "" };
}

/** Measured, not declared: the hardware a buyer's GPU and VRAM constraints are checked against. */
export async function detectHardware(): Promise<WorkerHardware> {
  const cpus = os.cpus();
  const gpu = await detectGpu();
  return {
    cpuModel: cpus[0]?.model.trim() || "unknown",
    vcpus: cpus.length,
    memGb: round1(os.totalmem() / 2 ** 30),
    ...(gpu ? { gpu } : {}),
  };
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Machine-wide utilisation since the previous call, including the job containers. */
export function utilSampler(hasGpu: boolean): () => Promise<WorkerUtil> {
  let prev = cpuTimes();
  return async () => {
    const cur = cpuTimes();
    const total = cur.total - prev.total;
    const cpuPct = total > 0 ? round1(100 * (1 - (cur.idle - prev.idle) / total)) : 0;
    prev = cur;
    const util: WorkerUtil = { cpuPct: Math.min(100, Math.max(0, cpuPct)) };
    if (hasGpu) {
      const row = await nvidiaSmi("utilization.gpu,memory.used");
      if (row?.[0] && row[1]) {
        util.gpuPct = Math.min(100, Math.max(0, Number(row[0])));
        util.vramUsedGb = round1(Number(row[1]) / 1024);
      }
    }
    return util;
  };
}
