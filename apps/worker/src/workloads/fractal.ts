import { spawn } from "node:child_process";
import { chmod, chown, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  FractalParams,
  type FractalParams as FractalParamsType,
  JOB_KILL_GRACE_SEC,
  RESULT_MAX_BYTES,
} from "@pekkah/protocol";
import { docker } from "../docker.js";
import type { JobContext, JobOutput, Workload } from "./types.js";

export interface FractalConfig {
  image: string;
  cpus: number;
  memory: string;
  dataDir: string;
}

const JOB_ID = /^[0-9A-Za-z_-]{1,64}$/;

/**
 * The job container (PLAN 7.3): no network, read-only root, a small tmpfs, every capability
 * dropped, uid 1000, capped memory, CPUs and pids, and the output dir as the only mount.
 * Arguments are an array, never a shell string.
 */
export function fractalDockerArgs(
  jobId: string,
  params: FractalParamsType,
  cfg: FractalConfig,
): string[] {
  if (!JOB_ID.test(jobId)) throw new Error("invalid job id");
  return [
    "run",
    "--rm",
    "--name",
    `pekkah-job-${jobId}`,
    "--label",
    `pekkah.job=${jobId}`,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    cfg.memory,
    "--memory-swap",
    cfg.memory,
    "--cpus",
    String(cfg.cpus),
    "--user",
    "1000:1000",
    "-e",
    `WORKERS=${cfg.cpus}`,
    "-v",
    `${join(cfg.dataDir, "jobs", jobId)}:/out`,
    cfg.image,
    JSON.stringify(params),
  ];
}

/** The worker talks to the host's Docker, so -v paths are host paths (section 7.3). */
async function prepareJobDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (process.getuid?.() === 0) await chown(dir, 1000, 1000);
  else await chmod(dir, 0o777);
}

export function createFractalWorkload(cfg: FractalConfig): Workload<FractalParamsType> {
  let imageReady: { at: number; ok: boolean } | undefined;

  return {
    name: "fractal",
    validate: (params) => FractalParams.parse(params),

    async ready() {
      if (imageReady && Date.now() - imageReady.at < 30_000) return imageReady.ok;
      const { code } = await docker(["image", "inspect", "--format", "{{.Id}}", cfg.image]);
      imageReady = { at: Date.now(), ok: code === 0 };
      return imageReady.ok;
    },

    async run(ctx: JobContext<FractalParamsType>): Promise<JobOutput> {
      // The abort listener below misses a cancel that came before it was added.
      const canceled = () => {
        if (ctx.signal.aborted) {
          throw new Error(`canceled before start: ${String(ctx.signal.reason ?? "canceled")}`);
        }
      };
      canceled();
      const dir = join(cfg.dataDir, "jobs", ctx.jobId);
      const name = `pekkah-job-${ctx.jobId}`;
      await prepareJobDir(dir);
      try {
        canceled();
        const child = spawn("docker", fractalDockerArgs(ctx.jobId, ctx.params, cfg), {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        let buffer = "";
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            const match = /^PROGRESS ([0-9.]+)$/.exec(line);
            if (match) ctx.progress(Math.round(Number(match[1]) * 100));
            nl = buffer.indexOf("\n");
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-4000);
        });

        let killedFor: string | null = null;
        const kill = (reason: string) => {
          if (killedFor) return;
          killedFor = reason;
          void docker(["kill", name]);
          child.kill("SIGKILL");
        };
        const timer = setTimeout(
          () => kill(`deadline ${ctx.deadlineSec} s + ${JOB_KILL_GRACE_SEC} s passed`),
          (ctx.deadlineSec + JOB_KILL_GRACE_SEC) * 1000,
        );
        const onAbort = () => kill(String(ctx.signal.reason ?? "canceled"));
        ctx.signal.addEventListener("abort", onAbort, { once: true });

        const code = await new Promise<number>((resolve) => {
          child.on("error", () => resolve(-1));
          child.on("close", (c) => resolve(c ?? -1));
        });
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);

        if (killedFor) throw new Error(`killed: ${killedFor}`);
        if (code !== 0) {
          throw new Error(
            `job container exited ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`,
          );
        }
        const file = join(dir, ctx.params.format === "raw" ? "result.bin" : "result.png");
        const size = (await stat(file)).size;
        if (size > RESULT_MAX_BYTES) throw new Error(`result too large: ${size} bytes`);
        return {
          mime: ctx.params.format === "raw" ? "application/octet-stream" : "image/png",
          data: await readFile(file),
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
