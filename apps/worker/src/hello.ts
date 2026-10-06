import type { HelloMsg, WorkerHardware } from "@pekkah/protocol";

export type HelloFields = Omit<HelloMsg, "type" | "warm">;

/** The market's limits on hello strings (PLAN2 PR-13). */
export const HELLO_BOUNDS = {
  name: 64,
  cpuModel: 80,
  gpuName: 64,
  driver: 32,
  version: 64,
  schedule: 64,
  prices: 4,
} as const;

const cut = (value: string, max: number) => value.trim().slice(0, max).trim();

/**
 * Detected strings (CPU model, GPU name, driver, version) come from the machine and can be
 * anything: cut them to the market's bounds so a long one never gets this worker refused.
 */
export function boundHardware(hw: WorkerHardware): WorkerHardware {
  const cpuModel = cut(hw.cpuModel, HELLO_BOUNDS.cpuModel) || "unknown";
  const gpuName = hw.gpu ? cut(hw.gpu.name, HELLO_BOUNDS.gpuName) : "";
  return {
    cpuModel,
    vcpus: hw.vcpus,
    memGb: hw.memGb,
    ...(hw.gpu && gpuName
      ? { gpu: { ...hw.gpu, name: gpuName, driver: cut(hw.gpu.driver, HELLO_BOUNDS.driver) } }
      : {}),
  };
}

export function boundHello(hello: HelloFields): HelloFields {
  const { schedule, ...rest } = hello;
  const bounded: HelloFields = {
    ...rest,
    name: cut(hello.name, HELLO_BOUNDS.name),
    version: cut(hello.version, HELLO_BOUNDS.version) || "unknown",
    hardware: boundHardware(hello.hardware),
    prices: hello.prices.slice(0, HELLO_BOUNDS.prices),
  };
  const s = schedule ? cut(schedule, HELLO_BOUNDS.schedule) : "";
  return s ? { ...bounded, schedule: s } : bounded;
}
