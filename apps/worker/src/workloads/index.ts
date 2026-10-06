import type { WorkerConfig } from "../config.js";
import { createFractalWorkload } from "./fractal.js";
import { createImageWorkload } from "./image.js";
import type { Workload } from "./types.js";

export type { JobContext, JobOutput, Workload } from "./types.js";

/** The whitelisted workloads this worker can run. PR-07b registers `image` here. */
export function createWorkloads(config: WorkerConfig): Workload[] {
  return [
    createFractalWorkload({
      image: config.FRACTAL_IMAGE,
      cpus: config.JOB_CPUS,
      memory: config.JOB_MEMORY,
      dataDir: config.DATA_DIR,
    }) as Workload,
    ...(config.FLUX_URL ? [createImageWorkload({ fluxUrl: config.FLUX_URL }) as Workload] : []),
  ];
}
