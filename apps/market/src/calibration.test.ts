import {
  CALIB_RATE_SHA256,
  CALIB_SHA256,
  type FractalCalibration,
  PRESET_COST,
} from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import { describe, expect, it } from "vitest";
import { createCalibrator } from "./calibration.js";
import { EventBus } from "./events.js";
import type { DispatchRequest, JobOutcome, WorkerRegistry } from "./workers.js";

const log = createLogger("calibration-test");

/** A registry stand-in that answers each calibration job with a fixed time and result. */
function fakeRegistry(answers: { overheadMs: number[]; rateMs: number; rateSha?: string }) {
  const overheads = [...answers.overheadMs];
  let resolve: (value: { fractal?: FractalCalibration; trusted: boolean }) => void = () => {};
  const done = new Promise<{ fractal?: FractalCalibration; trusted: boolean }>((r) => {
    resolve = r;
  });
  const registry = {
    isConnected: () => true,
    beginCalibration: () => {},
    endCalibration: () => {},
    dispatch: async (workerId: string, request: DispatchRequest): Promise<JobOutcome> => {
      const params = request.params as { preset: string; challenge?: number };
      const base = { ok: true as const, jobId: "j", workerId, mime: "x", data: Buffer.alloc(0) };
      if (params.preset === "tiny") {
        const ms = overheads.shift() ?? 0;
        return { ...base, sha256: "0".repeat(64), durationMs: ms, workerDurationMs: ms };
      }
      if (params.preset === "calib") {
        const sha256 = CALIB_SHA256[params.challenge ?? 0] ?? "";
        return { ...base, sha256, durationMs: 2500, workerDurationMs: 2500 };
      }
      const sha256 = answers.rateSha ?? CALIB_RATE_SHA256;
      return { ...base, sha256, durationMs: answers.rateMs, workerDurationMs: answers.rateMs };
    },
    setCalibration: (_id: string, update: { fractal?: FractalCalibration }, trusted = true) =>
      resolve({ ...update, trusted }),
  };
  return { registry: registry as unknown as WorkerRegistry, done };
}

describe("fractal calibration", () => {
  it("keeps the faster overhead run and prices from the timed hd-fast render", async () => {
    const { registry, done } = fakeRegistry({ overheadMs: [2150, 1410], rateMs: 12_000 });
    createCalibrator(new EventBus(log), log)(registry, "C", "fractal");
    const { fractal, trusted } = await done;
    expect(trusted).toBe(true);
    expect(fractal).toMatchObject({ overheadSec: 1.41, calibSec: 12, verified: true });
    expect(fractal?.secPerIter).toBeCloseTo((12 - 1.41) / PRESET_COST["hd-fast"], 15);
  });

  it("marks the worker untrusted when the timed render's answer is wrong", async () => {
    const { registry, done } = fakeRegistry({
      overheadMs: [900, 950],
      rateMs: 3000,
      rateSha: "f".repeat(64),
    });
    createCalibrator(new EventBus(log), log)(registry, "B", "fractal");
    const { fractal, trusted } = await done;
    expect(fractal?.verified).toBe(false);
    expect(trusted).toBe(false);
  });
});
