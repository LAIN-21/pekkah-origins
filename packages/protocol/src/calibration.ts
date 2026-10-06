import { CALIBRATION_DEADLINE_SEC } from "./constants.js";
import {
  CALIB_CHALLENGES,
  FractalParams,
  type ImageParams,
  type WorkloadName,
} from "./workloads.js";

// Calibration (PLAN 6.5) is generic: the market runs a workload's jobs on `hello`, and again when
// the workload first appears in a worker's `warm` list. PR-07b then needs no market change.

export type CalibrationJob =
  | {
      workload: "fractal";
      /** `overhead` → overheadSec (fixed cost); `challenge` → calibSec, answer checked. */
      step: "overhead" | "challenge";
      params: FractalParams;
      deadlineSec: number;
      /** True when the result's sha256 must equal the committed reference. */
      checked: boolean;
    }
  | {
      workload: "image";
      step: "timing";
      params: ImageParams;
      deadlineSec: number;
      checked: false;
    };

export interface CalibrationPlan {
  /** Whether the answers can be checked. GPU work is timed, not verified. */
  verifiable: boolean;
  /** The jobs in order. `challenge` picks the fractal view (0..7, random per calibration). */
  jobs(challenge: number): CalibrationJob[];
}

/** The one unverified image generation that measures secImage1024x4. */
export const IMAGE_CALIBRATION_PARAMS: ImageParams = {
  prompt: "A calibration card: a red sphere on a grey checkerboard, soft studio light",
  seed: 42,
  size: 1024,
  steps: 4,
};

export const CALIBRATION: Record<WorkloadName, CalibrationPlan> = {
  fractal: {
    verifiable: true,
    jobs(challenge) {
      if (!Number.isInteger(challenge) || challenge < 0 || challenge >= CALIB_CHALLENGES) {
        throw new RangeError(`challenge must be 0..${CALIB_CHALLENGES - 1}`);
      }
      return [
        {
          workload: "fractal",
          step: "overhead",
          params: FractalParams.parse({ preset: "tiny", format: "raw" }),
          deadlineSec: CALIBRATION_DEADLINE_SEC,
          checked: false,
        },
        {
          workload: "fractal",
          step: "challenge",
          params: FractalParams.parse({ preset: "calib", challenge, format: "raw" }),
          deadlineSec: CALIBRATION_DEADLINE_SEC,
          checked: true,
        },
      ];
    },
  },
  image: {
    verifiable: false,
    jobs() {
      return [
        {
          workload: "image",
          step: "timing",
          params: IMAGE_CALIBRATION_PARAMS,
          deadlineSec: CALIBRATION_DEADLINE_SEC,
          checked: false,
        },
      ];
    },
  },
};

export function randomChallenge(random: () => number = Math.random): number {
  return Math.floor(random() * CALIB_CHALLENGES) % CALIB_CHALLENGES;
}
