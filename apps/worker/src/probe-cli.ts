import { createHash } from "node:crypto";
import { randomChallenge } from "@pekkah/protocol";
import { createLogger, readEnv } from "@pekkah/runtime";
import { z } from "zod";
import { docker } from "./docker.js";
import { detectHardware } from "./hardware.js";
import { PUBLISHED_FRACTAL_IMAGE, probe, summary } from "./probe.js";
import { jobSizing } from "./sizing.js";
import { createFractalWorkload } from "./workloads/fractal.js";

/** `tsx src/index.ts probe`. In the image, it needs the Docker socket and the data dir mounted. */
export async function runProbeCli(): Promise<number> {
  const env = readEnv("probe", {
    FRACTAL_IMAGE: z.string().min(1).default(PUBLISHED_FRACTAL_IMAGE),
    JOB_CPUS: z.coerce.number().positive().max(64).optional(),
    JOB_MEMORY: z
      .string()
      .regex(/^\d+[bkmg]?$/i, "e.g. 2g")
      .optional(),
    DATA_DIR: z.string().min(1).default("/var/lib/pekkah"),
  });
  const hardware = await detectHardware();
  if (env.JOB_CPUS !== undefined && env.JOB_CPUS > hardware.vcpus) {
    // docker run --cpus would refuse every job with a message that doesn't say why.
    console.error(`JOB_CPUS is ${env.JOB_CPUS}, but this machine has ${hardware.vcpus} vCPUs.`);
    return 1;
  }
  const sized = jobSizing(hardware);
  const options = {
    fractalImage: env.FRACTAL_IMAGE,
    cpus: env.JOB_CPUS ?? sized.cpus,
    memory: env.JOB_MEMORY ?? sized.memory,
  };
  const fractal = createFractalWorkload({
    image: options.fractalImage,
    cpus: options.cpus,
    memory: options.memory,
    dataDir: env.DATA_DIR,
  });

  // Ctrl-C kills the running job container, as a cancel would.
  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => abort.abort(`probe stopped (${signal})`));
  }
  const log = createLogger("probe");
  log.level = "warn";

  console.log("Pekkah worker probe\n");
  const checks = await probe(options, {
    docker,
    hardware: async () => hardware,
    runFractal: async (jobId, params, deadlineSec) => {
      const out = await fractal.run({
        jobId,
        kind: "calibration",
        params,
        deadlineSec,
        signal: abort.signal,
        progress: () => {},
        log,
      });
      return createHash("sha256").update(out.data).digest("hex");
    },
    challenge: () => randomChallenge(),
    signal: abort.signal,
    now: () => performance.now(),
    print: (line) => console.log(line),
  });
  const result = summary(checks);
  console.log(`\n${result.line}`);
  return result.ok ? 0 : 1;
}
