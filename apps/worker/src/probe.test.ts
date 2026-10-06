import { createHash } from "node:crypto";
import {
  CALIB_RATE_SHA256,
  CALIB_SHA256,
  type FractalParams,
  type WorkerHardware,
} from "@pekkah/protocol";
import { describe, expect, it, vi } from "vitest";
import type { DockerResult } from "./docker.js";
import { type ProbeDeps, probe, summary } from "./probe.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): DockerResult => ({ code: 1, stdout: "", stderr });

const CPU: WorkerHardware = { cpuModel: "Test CPU", vcpus: 4, memGb: 8 };

/** Answers whose sha256 we control: the fake job returns a buffer, and we patch the references. */
function deps(over: Partial<ProbeDeps> & { answers?: Partial<Record<string, string>> } = {}) {
  const lines: string[] = [];
  const dockerCalls: string[][] = [];
  const answers = over.answers ?? {};
  const d: ProbeDeps = {
    docker: async (args) => {
      dockerCalls.push(args);
      if (args[0] === "version") return ok("27.3.1\n");
      if (args[0] === "info") return ok('{"runc":{"path":"runc"}}');
      if (args[0] === "image") return ok("sha256:5a499bd5ad26aa\n");
      return fail("unexpected");
    },
    hardware: async () => CPU,
    runFractal: vi.fn(async (_id: string, params: FractalParams) =>
      sha(answers[params.preset] ?? `answer for ${params.preset}`),
    ),
    challenge: () => 3,
    now: (() => {
      let t = 0;
      return () => (t += 1500);
    })(),
    print: (line) => lines.push(line),
    ...over,
  };
  return { d, lines, dockerCalls };
}

describe("probe", () => {
  it("fails a calibration answer that differs from the reference", async () => {
    // The fake answers can't hash to the real references, so both checked steps fail.
    const { d } = deps();
    const checks = await probe({ fractalImage: "img", cpus: 4, memory: "4g" }, d);
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ["docker", true],
      ["image", true],
      ["overhead", true],
      ["challenge", false],
      ["rate", false],
    ]);
    expect(summary(checks)).toEqual({ ok: false, line: "FAIL: challenge, rate." });
  });

  it("runs the market's calibration jobs, with the challenge view it picked", async () => {
    const { d } = deps();
    await probe({ fractalImage: "img", cpus: 4, memory: "4g" }, d);
    const presets = vi.mocked(d.runFractal).mock.calls.map(([id, p]) => [id.split("-")[0], p]);
    expect(presets).toEqual([
      ["probe", { preset: "tiny", palette: "ember", format: "raw" }],
      ["probe", { preset: "calib", challenge: 3, palette: "ember", format: "raw" }],
      ["probe", { preset: "hd-fast", palette: "ocean", format: "png" }],
    ]);
  });

  it("passes when both answers match the committed references", async () => {
    const { d } = deps({
      runFractal: async (_id, params) =>
        params.preset === "calib"
          ? (CALIB_SHA256[3] ?? "")
          : params.preset === "hd-fast"
            ? CALIB_RATE_SHA256
            : sha("tiny"),
    });
    const checks = await probe({ fractalImage: "img", cpus: 4, memory: "4g" }, d);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.find((c) => c.name === "rate")?.detail).toBe(
      "hd-fast render (speed), answer checked, 1.50 s",
    );
    expect(summary(checks)).toEqual({ ok: true, line: "PASS: every check passed." });
  });

  it("reports a job that fails, with the mount hint for a missing output", async () => {
    const { d } = deps({
      runFractal: async () => {
        throw new Error("ENOENT: no such file or directory, stat '/var/lib/pekkah/jobs/x'");
      },
    });
    const checks = await probe({ fractalImage: "img", cpus: 4, memory: "4g" }, d);
    expect(checks.find((c) => c.name === "overhead")).toMatchObject({ ok: false });
    expect(checks.find((c) => c.name === "overhead")?.detail).toContain(
      "-v /var/lib/pekkah:/var/lib/pekkah",
    );
  });

  it("starts no job or container after Ctrl-C", async () => {
    const abort = new AbortController();
    const { d, dockerCalls } = deps({
      signal: abort.signal,
      docker: async (args) => {
        dockerCalls.push(args);
        if (args[0] === "version") return ok("27.3.1");
        if (args[0] === "info") return ok('{"nvidia":{}}');
        if (args[0] === "image") return ok("sha256:abc");
        return ok("NVIDIA L4, 23034, 570.86.15");
      },
      runFractal: vi.fn(async () => {
        abort.abort("probe stopped (SIGINT)");
        return sha("tiny");
      }),
    });
    const checks = await probe({ fractalImage: "img", cpus: 1, memory: "1g" }, d);
    expect(d.runFractal).toHaveBeenCalledOnce();
    expect(checks.map((c) => c.name)).toEqual(["docker", "image", "overhead"]);
    expect(dockerCalls.some((a) => a[0] === "run")).toBe(false);
  });

  it("stops after the docker check when Docker is unreachable", async () => {
    const { d, dockerCalls } = deps({
      docker: async (args) => {
        dockerCalls.push(args);
        return fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
      },
    });
    const checks = await probe({ fractalImage: "img", cpus: 1, memory: "1g" }, d);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.detail).toContain("/var/run/docker.sock");
    expect(d.runFractal).not.toHaveBeenCalled();
  });

  it("pulls a missing image, and fails if the pull fails", async () => {
    const calls: string[][] = [];
    const { d } = deps({
      docker: async (args) => {
        calls.push(args);
        if (args[0] === "version") return ok("27.3.1");
        if (args[0] === "info") return ok("{}");
        if (args[0] === "image") return fail("No such image");
        return fail("pull access denied");
      },
    });
    const checks = await probe({ fractalImage: "ghcr.io/x/y:latest", cpus: 1, memory: "1g" }, d);
    expect(calls.some((a) => a[0] === "pull" && a.at(-1) === "ghcr.io/x/y:latest")).toBe(true);
    expect(checks.at(-1)).toMatchObject({ name: "image", ok: false });
    expect(d.runFractal).not.toHaveBeenCalled();
  });

  it("skips the GPU check on a CPU-only machine", async () => {
    const { d, lines, dockerCalls } = deps();
    const checks = await probe({ fractalImage: "img", cpus: 1, memory: "1g" }, d);
    expect(checks.some((c) => c.name === "gpu")).toBe(false);
    expect(dockerCalls.some((a) => a.includes("--gpus"))).toBe(false);
    expect(lines.join("\n")).toContain("CPU jobs only");
  });

  it("runs nvidia-smi in a --gpus all container when the NVIDIA runtime is present", async () => {
    const { d, dockerCalls } = deps({
      docker: async (args) => {
        dockerCalls.push(args);
        if (args[0] === "version") return ok("27.3.1");
        if (args[0] === "info") return ok('{"nvidia":{"path":"nvidia-container-runtime"}}');
        if (args[0] === "image") return ok("sha256:abc");
        if (args[0] === "run") return ok("NVIDIA RTX 4000 Ada Generation, 20475, 570.86.15\n");
        return fail("unexpected");
      },
    });
    const checks = await probe({ fractalImage: "img", cpus: 1, memory: "1g" }, d);
    const run = dockerCalls.find((a) => a[0] === "run") ?? [];
    expect(run.slice(0, 8)).toEqual([
      "run",
      "--rm",
      "--gpus",
      "all",
      "--network",
      "none",
      "--entrypoint",
      "nvidia-smi",
    ]);
    expect(checks.at(-1)).toMatchObject({ name: "gpu", ok: true });
    expect(checks.at(-1)?.detail).toContain("NVIDIA RTX 4000 Ada Generation, 20 GB");
  });

  it("fails the GPU check when a GPU is seen but containers can't use it", async () => {
    const { d } = deps({
      hardware: async () => ({ ...CPU, gpu: { name: "Tesla T4", vramGb: 15, driver: "550" } }),
      docker: async (args) => {
        if (args[0] === "version") return ok("27.3.1");
        if (args[0] === "info") return ok('{"runc":{}}');
        if (args[0] === "image") return ok("sha256:abc");
        return fail('could not select device driver "" with capabilities: [[gpu]]');
      },
    });
    const checks = await probe({ fractalImage: "img", cpus: 1, memory: "1g" }, d);
    expect(checks.at(-1)).toMatchObject({ name: "gpu", ok: false });
    expect(checks.at(-1)?.detail).toContain("NVIDIA Container Toolkit");
  });
});
