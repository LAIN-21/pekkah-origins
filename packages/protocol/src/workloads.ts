import { z } from "zod";
import { PROMPT_MAX_CHARS } from "./constants.js";

export const WorkloadName = z.enum(["fractal", "image"]);
export type WorkloadName = z.infer<typeof WorkloadName>;
export const WORKLOADS = WorkloadName.options;

// fractal (CPU) -------------------------------------------------------------------------------

export const FractalPresetName = z.enum(["tiny", "calib", "hd-fast", "hd-heavy"]);
export type FractalPresetName = z.infer<typeof FractalPresetName>;

export const FractalPalette = z.enum(["ember", "ocean", "mint"]);
export type FractalPalette = z.infer<typeof FractalPalette>;

export const FractalFormat = z.enum(["png", "raw"]);
export type FractalFormat = z.infer<typeof FractalFormat>;

/** Number of calibration views; a calibration picks one at random (6.5). */
export const CALIB_CHALLENGES = 8;

export const FractalParams = z
  .object({
    preset: FractalPresetName,
    challenge: z
      .number()
      .int()
      .min(0)
      .max(CALIB_CHALLENGES - 1)
      .optional(),
    palette: FractalPalette.default("ember"),
    format: FractalFormat.default("png"),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.preset === "calib" && p.challenge === undefined) {
      ctx.addIssue({ code: "custom", path: ["challenge"], message: "calib needs a challenge" });
    }
    if (p.preset !== "calib" && p.challenge !== undefined) {
      ctx.addIssue({ code: "custom", path: ["challenge"], message: "challenge is calib only" });
    }
  });
export type FractalParams = z.infer<typeof FractalParams>;
export type FractalParamsInput = z.input<typeof FractalParams>;

export interface FractalPreset {
  width: number;
  height: number;
  /** Samples per axis per pixel, averaged in integers. */
  supersample: number;
  maxIter: number;
  usedBy: string;
}

/** Starting values (PLAN 6.3). PR-05 tunes them on real hardware; workloads/fractal mirrors them. */
export const FRACTAL_PRESETS: Record<FractalPresetName, FractalPreset> = {
  tiny: { width: 8, height: 8, supersample: 1, maxIter: 1, usedBy: "measures fixed overhead" },
  calib: { width: 640, height: 360, supersample: 1, maxIter: 1500, usedBy: "calibration" },
  "hd-fast": { width: 1280, height: 720, supersample: 2, maxIter: 600, usedBy: "cpu-counter" },
  "hd-heavy": {
    width: 1920,
    height: 1080,
    supersample: 2,
    maxIter: 1500,
    usedBy: "cpu-tight, failover",
  },
};

// image (GPU) ---------------------------------------------------------------------------------

export const ImageSize = z.union([z.literal(768), z.literal(1024)]);
export type ImageSize = z.infer<typeof ImageSize>;

export const ImageParams = z
  .object({
    prompt: z.string().trim().min(1).max(PROMPT_MAX_CHARS),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1),
    size: ImageSize,
    steps: z.number().int().min(1).max(4),
  })
  .strict();
export type ImageParams = z.infer<typeof ImageParams>;

/** The public run button offers only these prompts. Free text exists only in the CLI and MCP. */
export const IMAGE_PROMPTS = [
  "A lighthouse on a rocky coast at dusk, warm light in the window, oil painting",
  "A small robot watering plants in a glass greenhouse, soft morning light",
  "A night market street with paper lanterns and steam rising from food stalls, cinematic",
  "A red fox asleep in fresh snow under pine trees, detailed, natural light",
  "A tiny isometric city on a floating island, clean pastel colours",
] as const;
export const IMAGE_PROMPT_COUNT = IMAGE_PROMPTS.length;

export type WorkloadParams<W extends WorkloadName> = W extends "fractal"
  ? FractalParams
  : ImageParams;
