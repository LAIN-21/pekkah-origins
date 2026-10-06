import { z } from "zod";
import { AtomicAmount, CardanoAddress, Id, IsoDate, WorkerId } from "./primitives.js";
import { CALIB_CHALLENGES, WorkloadName } from "./workloads.js";

export const WorkerStatus = z.enum(["calibrating", "online", "busy", "offline", "untrusted"]);
export type WorkerStatus = z.infer<typeof WorkerStatus>;

export const GpuInfo = z.object({
  name: z.string().min(1),
  vramGb: z.number().nonnegative(),
  driver: z.string(),
});
export type GpuInfo = z.infer<typeof GpuInfo>;

export const WorkerHardware = z.object({
  cpuModel: z.string(),
  vcpus: z.number().int().positive(),
  memGb: z.number().positive(),
  gpu: GpuInfo.optional(),
});
export type WorkerHardware = z.infer<typeof WorkerHardware>;

export const WorkerPrice = z.object({
  workload: WorkloadName,
  usd: z.number().positive(),
  atomic: AtomicAmount,
});
export type WorkerPrice = z.infer<typeof WorkerPrice>;

export const FractalCalibration = z.object({
  /** Measured dispatch-to-result time of the `tiny` preset. */
  overheadSec: z.number().nonnegative(),
  /** Measured dispatch-to-result time of the `calib` challenge view. */
  calibSec: z.number().nonnegative(),
  secPerIter: z.number().positive(),
  /** True only when sha256(result) matched the committed reference for the challenge. */
  verified: z.boolean(),
  challenge: z
    .number()
    .int()
    .min(0)
    .max(CALIB_CHALLENGES - 1),
  at: IsoDate,
});
export type FractalCalibration = z.infer<typeof FractalCalibration>;

export const ImageCalibration = z.object({
  /** One timed real generation at 1024², 4 steps. GPU work is timed, not verified. */
  secImage1024x4: z.number().positive(),
  verified: z.literal(false),
  at: IsoDate,
});
export type ImageCalibration = z.infer<typeof ImageCalibration>;

export const Calibration = z.object({
  fractal: FractalCalibration.optional(),
  image: ImageCalibration.optional(),
});
export type Calibration = z.infer<typeof Calibration>;

export const WorkerUtil = z.object({
  /** Share of the whole machine, 0..100. */
  cpuPct: z.number().min(0).max(100),
  gpuPct: z.number().min(0).max(100).optional(),
  vramUsedGb: z.number().nonnegative().optional(),
});
export type WorkerUtil = z.infer<typeof WorkerUtil>;

export const WorkerSnapshot = z.object({
  workerId: WorkerId,
  name: z.string(),
  payTo: CardanoAddress,
  hardware: WorkerHardware,
  prices: z.array(WorkerPrice),
  status: WorkerStatus,
  calibration: Calibration,
  /** A workload counts as offered only while it is listed here. */
  warm: z.array(WorkloadName),
  util: WorkerUtil.optional(),
  /** Live hours, e.g. `09:00-23:00 Asia/Singapore`. */
  schedule: z.string().optional(),
  lastSeenAt: IsoDate,
  currentJobId: Id.optional(),
});
export type WorkerSnapshot = z.infer<typeof WorkerSnapshot>;
