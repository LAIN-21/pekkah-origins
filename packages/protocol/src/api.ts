import { z } from "zod";
import { NETWORK } from "./constants.js";
import { JobEvent } from "./events.js";
import { Id, IsoDate, WorkerId } from "./primitives.js";
import { ScenarioName } from "./scenarios.js";
import { FractalParams, IMAGE_PROMPT_COUNT, ImageParams } from "./workloads.js";

// HTTP bodies (PLAN 5.4) that are not already covered by the market types.

/** GET /api/health. */
export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  /** The git sha, set at build time. */
  sha: z.string(),
  workersOnline: z.number().int().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** The facilitator's GET /health. */
export const FacilitatorHealth = z.object({
  ok: z.boolean(),
  network: z.literal(NETWORK),
  confirmationTimeoutMs: z.number().int().positive(),
});
export type FacilitatorHealth = z.infer<typeof FacilitatorHealth>;

/** GET /api/tx/:hash (the facilitator's GET /tx/:hash, from Blockfrost). */
export const TxStatus = z.object({
  found: z.boolean(),
  /** Block hash, once included. */
  block: z.string().optional(),
  confirmations: z.number().int().nonnegative().optional(),
});
export type TxStatus = z.infer<typeof TxStatus>;

const promptIndex = z
  .number()
  .int()
  .min(0)
  .max(IMAGE_PROMPT_COUNT - 1);

/** POST /api/demo/run. Public scenarios only, unless Bearer DEMO_TOKEN. */
export const DemoRunRequest = z.object({
  scenario: ScenarioName,
  /** One of the fixed prompts, for gpu-image. */
  promptIndex: promptIndex.optional(),
});
export type DemoRunRequest = z.infer<typeof DemoRunRequest>;

/** 202 from POST /api/demo/run. */
export const DemoRunAccepted = z.object({ runId: Id, scenario: ScenarioName });
export type DemoRunAccepted = z.infer<typeof DemoRunAccepted>;

/** The agent service's POST /run (Bearer AGENT_TOKEN). The market creates the runId. */
export const AgentRunRequest = z.object({
  scenario: ScenarioName,
  runId: Id,
  promptIndex: promptIndex.optional(),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequest>;

/** GET /api/runs/latest and GET /api/runs/:runId/events. */
export const RunLog = z.object({
  runId: Id,
  scenario: ScenarioName.optional(),
  startedAt: IsoDate.optional(),
  events: z.array(JobEvent),
});
export type RunLog = z.infer<typeof RunLog>;

/** POST /api/dev/dispatch: an unpaid test job (dev routes only). */
export const DevDispatchRequest = z.discriminatedUnion("workload", [
  z.object({ workerId: WorkerId, workload: z.literal("fractal"), params: FractalParams }),
  z.object({ workerId: WorkerId, workload: z.literal("image"), params: ImageParams }),
]);
export type DevDispatchRequest = z.infer<typeof DevDispatchRequest>;

export const ApiError = z.object({
  error: z.string(),
  message: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
