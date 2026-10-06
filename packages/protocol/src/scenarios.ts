import { z } from "zod";
import { ComputeRequest, type ComputeRequestInput } from "./request.js";
import { IMAGE_PROMPTS } from "./workloads.js";

// Scenario requests (PLAN 6.4). The agent's private ceilings live only in apps/agent: this
// package ships in the web bundle.

export const ScenarioName = z.enum([
  "gpu-image",
  "cpu-counter",
  "cpu-tight",
  "failover",
  "gpu-image-escrow",
  "fractal-escrow",
]);
export type ScenarioName = z.infer<typeof ScenarioName>;

/**
 * What a run is: one of the scenarios, or `custom`, a free-form request from the MCP or the CLI
 * (PLAN2 PR-13). Maps stay keyed by ScenarioName; a custom run has no scenario entry.
 */
export const RunScenario = z.union([ScenarioName, z.literal("custom")]);
export type RunScenario = z.infer<typeof RunScenario>;

export function isScenarioName(value: string): value is ScenarioName {
  return ScenarioName.safeParse(value).success;
}

/** Scenarios the public run button may start. Failover needs a real kill (demo-check or the CLI). */
export const PUBLIC_SCENARIOS = [
  "gpu-image",
  "cpu-counter",
  "cpu-tight",
] as const satisfies readonly ScenarioName[];
export type PublicScenario = (typeof PUBLIC_SCENARIOS)[number];

export function isPublicScenario(name: string): name is PublicScenario {
  return (PUBLIC_SCENARIOS as readonly string[]).includes(name);
}

/** `jobs` → POST /api/jobs/:offerId (paid to the worker); `escrow-jobs` → POST /api/escrow-jobs/:offerId (locked in Masumi escrow). */
export type ScenarioRoute = "jobs" | "escrow-jobs";

export interface ScenarioDef {
  name: ScenarioName;
  title: string;
  /** What my agent asks for, in plain words. */
  summary: string;
  route: ScenarioRoute;
  request: ComputeRequestInput;
}

const gpuImage: ComputeRequestInput = {
  workload: "image",
  params: { prompt: IMAGE_PROMPTS[0], seed: 7, size: 1024, steps: 4 },
  constraints: { gpu: true, minVramGb: 16, deadlineSec: 60 },
  budget: { maxUsd: 0.05 },
};

export const SCENARIOS: Record<ScenarioName, ScenarioDef> = {
  "gpu-image": {
    name: "gpu-image",
    title: "GPU image",
    summary: "My agent needs an image: a GPU with at least 16 GB, at most $0.05, within 60 s.",
    route: "jobs",
    request: gpuImage,
  },
  "cpu-counter": {
    name: "cpu-counter",
    title: "CPU counter-offer",
    summary: "My agent offers at most $0.015 for an HD render within 120 s.",
    route: "jobs",
    request: {
      workload: "fractal",
      params: { preset: "hd-fast", palette: "ocean", format: "png" },
      constraints: { deadlineSec: 120 },
      budget: { maxUsd: 0.015 },
    },
  },
  "cpu-tight": {
    name: "cpu-tight",
    title: "CPU tight deadline",
    summary: "My agent needs a heavy render within 20 s, at most $0.03.",
    route: "jobs",
    request: {
      workload: "fractal",
      params: { preset: "hd-heavy", palette: "ember", format: "png" },
      constraints: { deadlineSec: 20 },
      budget: { maxUsd: 0.03 },
    },
  },
  failover: {
    name: "failover",
    title: "Failover",
    summary: "My agent buys a heavy render at most $0.02 within 120 s; the job is killed mid-run.",
    route: "jobs",
    request: {
      workload: "fractal",
      params: { preset: "hd-heavy", palette: "mint", format: "png" },
      constraints: { deadlineSec: 120 },
      budget: { maxUsd: 0.02 },
    },
  },
  "gpu-image-escrow": {
    name: "gpu-image-escrow",
    title: "GPU image, Masumi escrow",
    summary: "As GPU image, but the payment is locked in Masumi escrow after delivery.",
    route: "escrow-jobs",
    request: gpuImage,
  },
  "fractal-escrow": {
    name: "fractal-escrow",
    title: "CPU render, Masumi escrow",
    summary:
      "An HD render on worker A, at most $0.05 within 120 s; the payment is locked in Masumi escrow after delivery.",
    route: "escrow-jobs",
    request: {
      workload: "fractal",
      params: { preset: "hd-fast", palette: "mint", format: "png" },
      constraints: { deadlineSec: 120, exclude: ["B", "C"] },
      budget: { maxUsd: 0.05 },
    },
  },
};

/**
 * A validated copy of a scenario's request. `promptIndex` picks one of the fixed prompts for the
 * image scenarios (the public run button never sends free text).
 */
export function scenarioRequest(
  name: ScenarioName,
  options: { promptIndex?: number } = {},
): ComputeRequest {
  const request = ComputeRequest.parse(SCENARIOS[name].request);
  if (options.promptIndex !== undefined && request.workload === "image") {
    const prompt = IMAGE_PROMPTS[options.promptIndex];
    if (prompt === undefined) throw new RangeError(`no prompt at index ${options.promptIndex}`);
    request.params.prompt = prompt;
  }
  return request;
}
