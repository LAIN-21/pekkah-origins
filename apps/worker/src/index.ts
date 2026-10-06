import { PEKKAH_VERSION, WorkerId } from "@pekkah/protocol";
import { createLogger, gitSha, readEnv } from "@pekkah/runtime";
import { z } from "zod";

// Skeleton: it starts, logs and stays up so the deploy can be checked. PR-04 adds hardware
// detection, the market connection, calibration and sandboxed jobs.

const env = readEnv("worker", {
  WORKER_ID: WorkerId.optional(),
  WORKER_NAME: z.string().optional(),
});
const log = createLogger("worker");

log.info(
  { workerId: env.WORKER_ID, name: env.WORKER_NAME, version: PEKKAH_VERSION, sha: gitSha() },
  "worker skeleton up; no market connection yet",
);
const idle = setInterval(() => log.info("worker idle"), 60_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(idle);
    log.info({ signal }, "worker stopping");
    process.exit(0);
  });
}
