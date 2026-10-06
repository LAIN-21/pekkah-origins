import type { WorkerHardware } from "@pekkah/protocol";
import { createLogger, gitSha } from "@pekkah/runtime";
import { type Refusal, WorkerAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { detectHardware, utilSampler } from "./hardware.js";
import type { HelloFields } from "./hello.js";
import { createWorkloads } from "./workloads/index.js";

export function refusalMessage(refusal: Refusal, workerId: string): string {
  const head = `The market refused worker ${workerId} (${refusal.code}): ${refusal.message}.`;
  const hint =
    refusal.code === "unauthorized"
      ? "Check WORKER_ID and WORKER_TOKEN: an allowlisted id needs its own token."
      : "Check the prices and the settings in the worker's env.";
  return `${head} ${hint} Not reconnecting.`;
}

export function runWorker(): void {
  const config = loadConfig();
  const log = createLogger("worker").child({ workerId: config.WORKER_ID });
  let hardware: WorkerHardware | undefined;

  // Detected again before every connect: a reconnect reports the machine as it is now.
  const hello = async (): Promise<HelloFields> => {
    const now = await detectHardware();
    if (JSON.stringify(now) !== JSON.stringify(hardware)) {
      log.info(
        { hardware: now, dataDir: config.DATA_DIR, jobCpus: config.JOB_CPUS },
        "hardware detected",
      );
    }
    hardware = now;
    return {
      workerId: config.WORKER_ID,
      token: config.WORKER_TOKEN,
      version: gitSha(),
      name: config.WORKER_NAME,
      payTo: config.PAYOUT_ADDRESS,
      hardware: now,
      prices: [
        { workload: "fractal", usd: config.PRICE_FRACTAL_USD },
        ...(config.PRICE_IMAGE_USD
          ? [{ workload: "image" as const, usd: config.PRICE_IMAGE_USD }]
          : []),
      ],
      ...(config.SCHEDULE ? { schedule: config.SCHEDULE } : {}),
    };
  };

  const agent = new WorkerAgent({
    url: config.MARKET_WS_URL,
    workloads: createWorkloads(config),
    sampleUtil: utilSampler(() => hardware?.gpu !== undefined),
    log,
    hello,
    onRefused: (refusal) => {
      console.error(refusalMessage(refusal, config.WORKER_ID));
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 1_000).unref();
    },
  });
  agent.start();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log.info({ signal }, "worker stopping");
      agent.stop();
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}
