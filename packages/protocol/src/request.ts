import { z } from "zod";
import { DEADLINE_MAX_SEC, DEADLINE_MIN_SEC } from "./constants.js";
import { WorkerId } from "./primitives.js";
import { FractalParams, ImageParams } from "./workloads.js";

export const Constraints = z.object({
  gpu: z.boolean().optional(),
  minVramGb: z.number().positive().max(1024).optional(),
  /** 120 s max: the job plus up to ~160 s of settling must fit the 600 s validity window. */
  deadlineSec: z.number().int().min(DEADLINE_MIN_SEC).max(DEADLINE_MAX_SEC),
  exclude: z.array(WorkerId).max(32).optional(),
});
export type Constraints = z.infer<typeof Constraints>;

/** What the agent offers to pay at most. Its private ceiling is never sent. */
export const Budget = z.object({
  maxUsd: z.number().positive().max(1000),
});
export type Budget = z.infer<typeof Budget>;

export const ComputeRequest = z.discriminatedUnion("workload", [
  z.object({
    workload: z.literal("fractal"),
    params: FractalParams,
    constraints: Constraints,
    budget: Budget,
  }),
  z.object({
    workload: z.literal("image"),
    params: ImageParams,
    constraints: Constraints,
    budget: Budget,
  }),
]);
export type ComputeRequest = z.infer<typeof ComputeRequest>;
export type ComputeRequestInput = z.input<typeof ComputeRequest>;
