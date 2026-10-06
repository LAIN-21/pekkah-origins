import { randomInt } from "node:crypto";
import {
  CALIB_CHALLENGES,
  CALIB_ITERS,
  CALIB_SHA256,
  CALIBRATION,
  type WorkloadName,
} from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import type { EventBus } from "./events.js";
import type { WorkerRegistry } from "./workers.js";

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Generic calibration (PLAN 6.5). Each worker calibrates one workload at a time; the jobs come
 * from packages/protocol, so a new workload needs no market change.
 */
export function createCalibrator(bus: EventBus, log: Logger) {
  const chains = new Map<string, Promise<void>>();

  async function calibrate(registry: WorkerRegistry, workerId: string, workload: WorkloadName) {
    if (!registry.isConnected(workerId)) return;
    registry.beginCalibration(workerId);
    const at = () => new Date().toISOString();
    try {
      if (workload === "fractal") {
        const challenge = randomInt(CALIB_CHALLENGES);
        const [overheadJob, challengeJob] = CALIBRATION.fractal.jobs(challenge);
        if (overheadJob?.workload !== "fractal" || challengeJob?.workload !== "fractal") return;
        const overhead = await registry.dispatch(workerId, {
          ...overheadJob,
          kind: "calibration",
          quiet: true,
        });
        if (!overhead.ok) throw new Error(`overhead job failed: ${overhead.error}`);
        const timed = await registry.dispatch(workerId, {
          ...challengeJob,
          kind: "calibration",
          quiet: true,
        });
        if (!timed.ok) throw new Error(`challenge job failed: ${timed.error}`);
        const overheadSec = round3(overhead.durationMs / 1000);
        const calibSec = round3(timed.durationMs / 1000);
        // Catches a faulty worker, not a cheating one: the 8 challenges are public, so a
        // worker could replay stored answers (PLAN 6.5). Only allowlisted tokens join.
        const expected = CALIB_SHA256[challenge];
        const iterations = CALIB_ITERS[challenge] ?? 0;
        const verified = expected !== undefined && timed.sha256 === expected && iterations > 0;
        const secPerIter = Math.max(calibSec - overheadSec, 0.05) / Math.max(iterations, 1);
        registry.setCalibration(
          workerId,
          { fractal: { overheadSec, calibSec, secPerIter, verified, challenge, at: at() } },
          verified,
        );
        log.info({ workerId, challenge, overheadSec, calibSec, verified }, "fractal calibrated");
        bus.emit({
          source: "market",
          type: "worker.calibrated",
          data: { workerId, workload, verified, sec: calibSec },
        });
        return;
      }
      const [job] = CALIBRATION.image.jobs(0);
      if (job?.workload !== "image") return;
      const timed = await registry.dispatch(workerId, { ...job, kind: "calibration", quiet: true });
      if (!timed.ok) throw new Error(`image job failed: ${timed.error}`);
      const sec = round3(timed.durationMs / 1000);
      registry.setCalibration(workerId, {
        image: { secImage1024x4: sec, verified: false, at: at() },
      });
      log.info({ workerId, secImage1024x4: sec }, "image calibrated (timed, not verified)");
      bus.emit({
        source: "market",
        type: "worker.calibrated",
        data: { workerId, workload, verified: false, sec },
      });
    } catch (err) {
      log.warn(
        { workerId, workload, err: err instanceof Error ? err.message : err },
        "calibration failed",
      );
    } finally {
      registry.endCalibration(workerId);
    }
  }

  return (registry: WorkerRegistry, workerId: string, workload: WorkloadName): void => {
    const previous = chains.get(workerId) ?? Promise.resolve();
    const next = previous.then(() => calibrate(registry, workerId, workload));
    chains.set(workerId, next);
  };
}
