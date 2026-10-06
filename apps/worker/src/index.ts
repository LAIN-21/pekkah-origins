import { createLogger, gitSha } from "@pekkah/runtime";
import { WorkerAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { detectHardware, utilSampler } from "./hardware.js";
import { createWorkloads } from "./workloads/index.js";

const config = loadConfig();
const log = createLogger("worker").child({ workerId: config.WORKER_ID });
const hardware = await detectHardware();
log.info({ hardware, dataDir: config.DATA_DIR, jobCpus: config.JOB_CPUS }, "hardware measured");

const agent = new WorkerAgent({
  url: config.MARKET_WS_URL,
  workloads: createWorkloads(config),
  sampleUtil: utilSampler(hardware.gpu !== undefined),
  log,
  hello: {
    workerId: config.WORKER_ID,
    token: config.WORKER_TOKEN,
    version: gitSha(),
    name: config.WORKER_NAME,
    payTo: config.PAYOUT_ADDRESS,
    hardware,
    prices: [
      { workload: "fractal", usd: config.PRICE_FRACTAL_USD },
      ...(config.PRICE_IMAGE_USD
        ? [{ workload: "image" as const, usd: config.PRICE_IMAGE_USD }]
        : []),
    ],
    ...(config.SCHEDULE ? { schedule: config.SCHEDULE } : {}),
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
