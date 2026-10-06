import { type ComputeRequest, PRESET_COST, type WorkerSnapshot } from "@pekkah/protocol";

/** Safety margins over the measured rates (PLAN 6.2). */
export const FRACTAL_MARGIN = 1.15;
export const IMAGE_MARGIN = 1.2;
export const IMAGE_FIXED_SEC = 1.0;

/**
 * A fractal request's work in hd-heavy-equivalent iterations, measured on the real workers
 * (`pnpm measure --costs`); null when unknown. `tiny` is the fixed overhead itself.
 */
export function fractalCost(params: { preset: string }): number | null {
  if (params.preset === "tiny") return 0;
  const cost = PRESET_COST[params.preset as keyof typeof PRESET_COST];
  return typeof cost === "number" ? cost : null;
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
    const cost = fractalCost(request.params);
    if (!cal || cost === null) return null;
    return round1(cal.overheadSec + cal.secPerIter * cost * FRACTAL_MARGIN);
  }
  const cal = worker.calibration.image;
  if (!cal) return null;
  const { steps, size } = request.params;
  return round1(
    IMAGE_FIXED_SEC + cal.secImage1024x4 * (steps / 4) * (size / 1024) ** 2 * IMAGE_MARGIN,
  );
}
