import { randomBytes } from "node:crypto";
import {
  CALIB_RATE_SHA256,
  CALIB_SHA256,
  CALIBRATION,
  type FractalParams,
  type WorkerHardware,
} from "@pekkah/protocol";
import type { Docker, DockerResult } from "./docker.js";
import { GPU_QUERY, parseGpuRow } from "./hardware.js";

// `probe`: what this machine reports, and whether it passes the market's checks, before it joins.
// Nothing here talks to the market. Exit code 0 only when every check passed.

export const PUBLISHED_FRACTAL_IMAGE = "ghcr.io/lain-21/pekkah-fractal:latest";

export interface ProbeOptions {
  fractalImage: string;
  cpus: number;
  memory: string;
}

export interface ProbeDeps {
  docker: Docker;
  hardware: () => Promise<WorkerHardware>;
  /** Runs one fractal job in the real job sandbox and returns the sha256 of its output. */
  runFractal: (jobId: string, params: FractalParams, deadlineSec: number) => Promise<string>;
  challenge: () => number;
  now: () => number;
  /** Aborted on Ctrl-C: no further job or container starts. */
  signal?: AbortSignal;
  print: (line: string) => void;
}

export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const lastLine = (r: DockerResult) =>
  (r.stderr.trim() || r.stdout.trim()).split("\n").at(-1)?.trim() || `exit ${r.code}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

export async function probe(o: ProbeOptions, d: ProbeDeps): Promise<ProbeCheck[]> {
  const checks: ProbeCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    d.print(`  ${ok ? "✓" : "✗"} ${name.padEnd(9)} ${detail}`);
  };

  const hw = await d.hardware();
  const version = await d.docker(["version", "--format", "{{.Server.Version}}"]);
  const dockerOk = version.code === 0 && version.stdout.trim() !== "";
  const runtimes = dockerOk ? await d.docker(["info", "--format", "{{json .Runtimes}}"]) : null;
  const nvidiaRuntime = runtimes?.code === 0 && /"nvidia"/.test(runtimes.stdout);

  d.print("Machine (as this machine reports it)");
  d.print(`  CPU      ${hw.cpuModel}, ${hw.vcpus} vCPU`);
  d.print(`  Memory   ${hw.memGb} GB`);
  d.print(
    `  GPU      ${hw.gpu ? `${hw.gpu.name}, ${hw.gpu.vramGb} GB, driver ${hw.gpu.driver}` : "none seen by nvidia-smi here"}`,
  );
  d.print(`  Docker   ${dockerOk ? version.stdout.trim() : "unreachable"}`);
  d.print(`  NVIDIA   container runtime ${nvidiaRuntime ? "present" : "not found"}`);
  d.print(`  Jobs     ${o.cpus} CPUs, ${o.memory} memory, ${o.fractalImage}`);
  d.print("");
  d.print("Checks");

  if (!dockerOk) {
    check(
      "docker",
      false,
      `unreachable: ${lastLine(version)}. In a container, mount -v /var/run/docker.sock:/var/run/docker.sock`,
    );
    return checks;
  }
  check("docker", true, `server ${version.stdout.trim()}`);

  let image = await d.docker(["image", "inspect", "--format", "{{.Id}}", o.fractalImage]);
  if (image.code !== 0) {
    const pull = await d.docker(["pull", "--quiet", o.fractalImage]);
    if (pull.code !== 0) {
      check("image", false, `${o.fractalImage} is missing and the pull failed: ${lastLine(pull)}`);
      return checks;
    }
    image = await d.docker(["image", "inspect", "--format", "{{.Id}}", o.fractalImage]);
  }
  check("image", image.code === 0, `${o.fractalImage} ${image.stdout.trim().slice(0, 19)}`);

  // The market's own calibration jobs (PLAN 6.5), with the same reference answers.
  const challenge = d.challenge();
  const run = randomBytes(3).toString("hex");
  for (const [i, job] of CALIBRATION.fractal.jobs(challenge).entries()) {
    if (job.workload !== "fractal") continue;
    if (d.signal?.aborted) return checks;
    const expected =
      job.step === "challenge"
        ? CALIB_SHA256[challenge]
        : job.step === "rate"
          ? CALIB_RATE_SHA256
          : undefined;
    const what =
      job.step === "overhead"
        ? "tiny preset (fixed cost)"
        : job.step === "challenge"
          ? `calib view ${challenge}`
          : "hd-fast render (speed)";
    const started = d.now();
    try {
      const digest = await d.runFractal(`probe-${run}-${i}`, job.params, job.deadlineSec);
      const took = secs(d.now() - started);
      if (!expected) check(job.step, true, `${what}, ${took}`);
      else if (digest === expected) check(job.step, true, `${what}, answer checked, ${took}`);
      else check(job.step, false, `${what}: the answer differs from the reference, ${took}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = /ENOENT/.test(message)
        ? ". In a container, mount the data dir at the same path: -v /var/lib/pekkah:/var/lib/pekkah"
        : "";
      check(job.step, false, `${what}: ${message}${hint}`);
    }
  }

  if (d.signal?.aborted) return checks;
  if (hw.gpu || nvidiaRuntime) {
    const gpu = await d.docker([
      "run",
      "--rm",
      "--gpus",
      "all",
      "--network",
      "none",
      "--entrypoint",
      "nvidia-smi",
      o.fractalImage,
      `--query-gpu=${GPU_QUERY}`,
      "--format=csv,noheader,nounits",
    ]);
    const seen =
      gpu.code === 0 ? parseGpuRow(gpu.stdout.trim().split("\n")[0]?.split(",")) : undefined;
    if (seen) {
      check(
        "gpu",
        true,
        `${seen.name}, ${seen.vramGb} GB, driver ${seen.driver}, in a --gpus all container`,
      );
    } else {
      const hint = nvidiaRuntime ? "" : ". Install the NVIDIA Container Toolkit";
      check("gpu", false, `a --gpus all container failed: ${lastLine(gpu)}${hint}`);
    }
  } else {
    d.print("  - gpu       no GPU found: this machine sells CPU jobs only");
  }
  return checks;
}

export function summary(checks: ProbeCheck[]): { ok: boolean; line: string } {
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  return failed.length === 0
    ? { ok: true, line: "PASS: every check passed." }
    : { ok: false, line: `FAIL: ${failed.join(", ")}.` };
}
