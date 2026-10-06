import {
  CALIB_ITERS,
  type ComputeRequest,
  PRESET_ITERS,
  type WorkerSnapshot,
} from "@pekkah/protocol";

/** Safety margins over the measured rates (PLAN 6.2). */
export const FRACTAL_MARGIN = 1.15;
export const IMAGE_MARGIN = 1.2;
export const IMAGE_FIXED_SEC = 1.0;

/** Exact total iterations of a fractal request, from the committed calib:ref totals. */
export function fractalIterations(params: { preset: string; challenge?: number }): number | null {
  if (params.preset === "calib") return CALIB_ITERS[params.challenge ?? -1] ?? null;
  const iters = PRESET_ITERS[params.preset as keyof typeof PRESET_ITERS];
  return typeof iters === "number" ? iters : null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Estimated seconds from dispatch to result, from the worker's measured calibration; null
 * when that workload is not calibrated. The fixed cost (container start, imports, transfer)
 * is not scaled with the work, or big jobs would look alike on fast and slow machines.
 */
export function estimateSec(request: ComputeRequest, worker: WorkerSnapshot): number | null {
  if (request.workload === "fractal") {
    const cal = worker.calibration.fractal;
    const iterations = fractalIterations(request.params);
    if (!cal || iterations === null) return null;
    return round1(cal.overheadSec + cal.secPerIter * iterations * FRACTAL_MARGIN);
  }
  const cal = worker.calibration.image;
  if (!cal) return null;
  const { steps, size } = request.params;
  return round1(
    IMAGE_FIXED_SEC + cal.secImage1024x4 * (steps / 4) * (size / 1024) ** 2 * IMAGE_MARGIN,
  );
}
