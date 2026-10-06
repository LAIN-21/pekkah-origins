import { HELLO_LIMITS, type HelloMsg, type WorkerHardware } from "@pekkah/protocol";

export type HelloFields = Omit<HelloMsg, "type" | "warm">;

const cut = (value: string, max: number) => value.trim().slice(0, max).trim();

/**
 * Detected strings (CPU model, GPU name, driver, version) come from the machine and can be
 * anything: cut them to the market's bounds so a long one never gets this worker refused.
 */
export function boundHardware(hw: WorkerHardware): WorkerHardware {
  const cpuModel = cut(hw.cpuModel, HELLO_LIMITS.cpuModel) || "unknown";
  const gpuName = hw.gpu ? cut(hw.gpu.name, HELLO_LIMITS.gpuName) : "";
  return {
    cpuModel,
    vcpus: hw.vcpus,
    memGb: hw.memGb,
    ...(hw.gpu && gpuName
      ? { gpu: { ...hw.gpu, name: gpuName, driver: cut(hw.gpu.driver, HELLO_LIMITS.driver) } }
      : {}),
  };
}

export function boundHello(hello: HelloFields): HelloFields {
  const { schedule, ...rest } = hello;
  const bounded: HelloFields = {
    ...rest,
    name: cut(hello.name, HELLO_LIMITS.name),
    version: cut(hello.version, HELLO_LIMITS.version) || "unknown",
    hardware: boundHardware(hello.hardware),
    prices: hello.prices.slice(0, HELLO_LIMITS.prices),
  };
  const s = schedule ? cut(schedule, HELLO_LIMITS.schedule) : "";
  return s ? { ...bounded, schedule: s } : bounded;
}
