import { describe, expect, it } from "vitest";
import { CALIBRATION, IMAGE_CALIBRATION_PARAMS, randomChallenge } from "./calibration.js";
import { ImageParams } from "./workloads.js";

describe("calibration plans", () => {
  it("measures fractal overhead, a checked challenge view, then a checked timed render", () => {
    const jobs = CALIBRATION.fractal.jobs(5);
    expect(CALIBRATION.fractal.verifiable).toBe(true);
    expect(jobs.map((j) => [j.step, j.checked])).toEqual([
      ["overhead", false],
      ["challenge", true],
      ["rate", true],
    ]);
    expect(jobs[2]?.params).toEqual({ preset: "hd-fast", palette: "ocean", format: "png" });
    expect(jobs[1]?.params).toEqual({
      preset: "calib",
      challenge: 5,
      palette: "ember",
      format: "raw",
    });
    expect(() => CALIBRATION.fractal.jobs(8)).toThrow(RangeError);
  });

  it("times one unverified image generation at 1024², 4 steps, seed 42", () => {
    expect(CALIBRATION.image.verifiable).toBe(false);
    const [job] = CALIBRATION.image.jobs(0);
    expect(job?.params).toMatchObject({ size: 1024, steps: 4, seed: 42 });
    expect(ImageParams.safeParse(IMAGE_CALIBRATION_PARAMS).success).toBe(true);
  });

  it("picks challenges in range", () => {
    expect(randomChallenge(() => 0)).toBe(0);
    expect(randomChallenge(() => 0.999999)).toBe(7);
    expect(randomChallenge(() => 1)).toBe(0);
  });
});
