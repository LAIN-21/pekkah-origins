import type { WorkerHardware } from "@pekkah/protocol";

/**
 * Default job limits for a machine: every vCPU, and half the RAM capped at 8 GB (a fractal job
 * never needs more). Matches workers B (8 vCPU, 16 GB → 8, 8g) and C (2 vCPU, 2 GB → 2, 1g).
 * install.sh applies the same rule.
 */
export function jobSizing(hw: Pick<WorkerHardware, "vcpus" | "memGb">): {
  cpus: number;
  memory: string;
} {
  const memGb = Math.min(8, Math.max(1, Math.round(hw.memGb / 2)));
  return { cpus: Math.max(1, hw.vcpus), memory: `${memGb}g` };
}
