import {
  ImageParams,
  type ImageParams as ImageParamsType,
  JOB_KILL_GRACE_SEC,
  RESULT_MAX_BYTES,
} from "@pekkah/protocol";
import type { JobContext, JobOutput, Workload } from "./types.js";

// Image jobs (PR-07b) are HTTP calls to the warm flux server, which sits on the
// internal pekkah-jobs network with no internet (PLAN 7.2, 7.3). The prompt is
// validated here (at most 300 characters) and sent as JSON, never as a shell argument.

export interface ImageConfig {
  /** http://flux:8000 on worker A. */
  fluxUrl: string;
}

const HEALTH_TIMEOUT_MS = 3_000;
/** The worker polls ready() every 5 s; a fresh answer is reused for this long. */
const HEALTH_CACHE_MS = 4_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk, or null if the bytes aren't a PNG. */
export function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (data.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export function createImageWorkload(
  cfg: ImageConfig,
  fetchImpl: typeof fetch = fetch,
): Workload<ImageParamsType> {
  let health: { at: number; ok: boolean } | undefined;

  return {
    name: "image",
    validate: (params) => ImageParams.parse(params),

    /** Offered only while flux says it is ready: then `image` is in warm[]. */
    async ready() {
      if (health && Date.now() - health.at < HEALTH_CACHE_MS) return health.ok;
      let ok = false;
      try {
        const res = await fetchImpl(new URL("/health", cfg.fluxUrl), {
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        const body: unknown = res.ok ? await res.json() : null;
        ok =
          typeof body === "object" && body !== null && (body as { ready?: unknown }).ready === true;
      } catch {
        ok = false;
      }
      health = { at: Date.now(), ok };
      return ok;
    },

    async run(ctx: JobContext<ImageParamsType>): Promise<JobOutput> {
      if (ctx.signal.aborted) {
        throw new Error(`canceled before start: ${String(ctx.signal.reason ?? "canceled")}`);
      }
      const deadline = AbortSignal.timeout((ctx.deadlineSec + JOB_KILL_GRACE_SEC) * 1000);
      const signal = AbortSignal.any([ctx.signal, deadline]);
      const { prompt, seed, size, steps } = ctx.params;

      let res: Response;
      try {
        res = await fetchImpl(new URL("/generate", cfg.fluxUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt, seed, size, steps }),
          signal,
        });
      } catch (err) {
        if (deadline.aborted) {
          throw new Error(`killed: deadline ${ctx.deadlineSec} s + ${JOB_KILL_GRACE_SEC} s passed`);
        }
        if (ctx.signal.aborted)
          throw new Error(`killed: ${String(ctx.signal.reason ?? "canceled")}`);
        throw new Error(`flux unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`flux answered ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > RESULT_MAX_BYTES) throw new Error(`result too large: ${data.length} bytes`);
      const dims = pngSize(data);
      if (!dims) throw new Error("flux returned bytes that are not a PNG");
      if (dims.width !== size || dims.height !== size) {
        throw new Error(`expected a ${size}x${size} PNG, got ${dims.width}x${dims.height}`);
      }
      const ms = res.headers.get("x-duration-ms");
      ctx.log.info(
        { generateMs: ms ? Number(ms) : undefined, bytes: data.length },
        "image generated",
      );
      return { mime: "image/png", data };
    },
  };
}
