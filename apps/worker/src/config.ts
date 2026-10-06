import { CardanoAddress, HELLO_LIMITS, WorkerId } from "@pekkah/protocol";
import { readEnv } from "@pekkah/runtime";
import { z } from "zod";

const usd = z.coerce.number().positive().max(1);

export function loadConfig() {
  return readEnv("worker", {
    WORKER_ID: WorkerId,
    WORKER_NAME: z.string().min(1).max(HELLO_LIMITS.name),
    /** Only for an allowlisted id. Without one, the worker joins on probation (PR-17). */
    WORKER_TOKEN: z.string().min(16).optional(),
    MARKET_WS_URL: z
      .string()
      .url()
      .refine((u) => /^wss?:\/\//.test(u), "must be ws:// or wss://"),
    /** The worker that is paid is the worker that ran the job: this is its address. */
    PAYOUT_ADDRESS: CardanoAddress,
    PRICE_FRACTAL_USD: usd,
    PRICE_IMAGE_USD: usd.optional(),
    SCHEDULE: z.string().max(HELLO_LIMITS.schedule).optional(),
    JOB_CPUS: z.coerce.number().positive().max(64).default(1),
    JOB_MEMORY: z
      .string()
      .regex(/^\d+[bkmg]?$/i, "e.g. 2g")
      .default("1g"),
    FRACTAL_IMAGE: z.string().min(1).default("pekkah/fractal:local"),
    FLUX_URL: z.string().url().optional(),
    // Local dev on a Mac uses $HOME/.pekkah/data: /var/lib needs root there.
    DATA_DIR: z.string().min(1).default("/var/lib/pekkah"),
  });
}

export type WorkerConfig = ReturnType<typeof loadConfig>;
