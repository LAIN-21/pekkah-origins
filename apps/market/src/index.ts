import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { masumiSeller } from "@pekkah/payments";
import { AssetId, CardanoAddress, DEFAULT_ASSET, PEKKAH_VERSION } from "@pekkah/protocol";
import { assertMnemonic, createLogger, envFlag, envPort, gitSha, readEnv } from "@pekkah/runtime";
import { z } from "zod";
import { createApp } from "./app.js";
import { createCalibrator } from "./calibration.js";
import { DemoController } from "./demo.js";
import { registerDemoRoute } from "./demo-route.js";
import {
  bearerGuard,
  registerDevDispatchRoutes,
  registerSmokeEscrowRoute,
  registerSmokeRoute,
} from "./dev.js";
import { escrowCommitment } from "./escrow.js";
import { EventBus } from "./events.js";
import { JobStore } from "./jobs.js";
import { OfferStore } from "./offers.js";
import { registerPaidJobRoute } from "./paid.js";
import { createMarketPayments } from "./payments.js";
import { registerQuoteRoute } from "./quotes.js";
import { tryCreateResultSubmitter } from "./result-submit.js";
import { registerAgentEvents, registerReadRoutes } from "./routes.js";
import { RunStore } from "./runs.js";
import { UiHub } from "./ui.js";
import { parseWorkerTokens, WorkerRegistry } from "./workers.js";

const env = readEnv("market", {
  MARKET_PORT: envPort(8080),
  FACILITATOR_URL: z.string().url().default("http://127.0.0.1:4022"),
  FACILITATOR_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  PEKKAH_ASSET: AssetId.default(DEFAULT_ASSET),
  L1_CONFIRMATIONS: z.coerce.number().int().min(0).max(20).default(0),
  PEKKAH_DEV_ROUTES: envFlag,
  DEMO_TOKEN: z.string().min(16).optional(),
  SELLER_A_ADDRESS: CardanoAddress.optional(),
  SELLER_B_ADDRESS: CardanoAddress.optional(),
  SELLER_C_ADDRESS: CardanoAddress.optional(),
  SELLER_A_MNEMONIC: z.string().optional(),
  /** `A:<token>,B:<token>,C:<token>`: the allowlist of workers that may join. */
  WORKER_TOKENS: z.string().min(1),
  DEMO_DAILY_RUNS: z.coerce.number().int().min(0).default(40),
  AGENT_TOKEN: z.string().min(16),
  AGENT_URL: z.string().url().default("http://127.0.0.1:4100"),
  DEMO_COOLDOWN_SEC: z.coerce.number().int().min(0).default(120),
  DATA_DIR: z.string().min(1).default("/var/lib/pekkah"),
});
const log = createLogger("market");
if (env.PEKKAH_DEV_ROUTES && !env.DEMO_TOKEN) {
  console.error("market: env missing DEMO_TOKEN (PEKKAH_DEV_ROUTES=1 needs it)");
  process.exit(1);
}

// Masumi needs Seller A's key to sign the escrow terms, and only when it derives
// SELLER_A_ADDRESS (worker A's payout address). Otherwise the market runs without Masumi.
function loadMasumiSeller() {
  if (!env.SELLER_A_MNEMONIC) return undefined;
  if (!env.SELLER_A_ADDRESS) {
    log.error("Masumi disabled: SELLER_A_MNEMONIC is set but SELLER_A_ADDRESS is not");
    return undefined;
  }
  try {
    return masumiSeller(env.SELLER_A_MNEMONIC, env.SELLER_A_ADDRESS);
  } catch (err) {
    // The message names the variable and a position, never a word or a key.
    log.error(`Masumi disabled: ${err instanceof Error ? err.message : "invalid seller key"}`);
    return undefined;
  }
}
const seller = loadMasumiSeller();

const sha = gitSha();
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const bus = new EventBus(log);
const offers = new OfferStore();
const jobs = new JobStore();
const runs = new RunStore(bus, env.DATA_DIR, log);
// The paid job's status follows the worker: dispatched, then running once it accepts.
bus.subscribe((event) => {
  if (event.type !== "job.running" || !event.jobId) return;
  const job = jobs.get(event.jobId);
  if (job?.status === "dispatched") job.status = "running";
});
// PR-10b: with Masumi on, the market submits each escrow job's result hash as Seller A, with
// the key it already holds to sign the escrow terms. Chain access goes through the facilitator.
const submitResult =
  seller && env.SELLER_A_MNEMONIC && env.SELLER_A_ADDRESS
    ? tryCreateResultSubmitter({
        chainUrl: `${env.FACILITATOR_URL.replace(/\/+$/, "")}/blockfrost`,
        sellerMnemonic: assertMnemonic("SELLER_A_MNEMONIC", env.SELLER_A_MNEMONIC),
        sellerAddress: env.SELLER_A_ADDRESS,
        log,
      })
    : null;
const escrowResults = submitResult
  ? {
      submit: submitResult,
      txFound: async (txHash: string) => {
        const res = await fetch(`${env.FACILITATOR_URL.replace(/\/+$/, "")}/tx/${txHash}`, {
          signal: AbortSignal.timeout(20_000),
        });
        return res.ok && ((await res.json()) as { found?: boolean }).found === true;
      },
    }
  : undefined;
const payments = createMarketPayments(
  {
    facilitatorUrl: env.FACILITATOR_URL,
    timeoutMs: env.FACILITATOR_TIMEOUT_MS,
    // One commitment callback for every Masumi route: escrow jobs bind to the quoted request.
    ...(seller ? { masumi: { seller, commitment: escrowCommitment(offers) } } : {}),
  },
  bus,
  log,
  { jobs, offers },
  escrowResults,
);
const registry = new WorkerRegistry({
  tokens: parseWorkerTokens(env.WORKER_TOKENS),
  bus,
  log,
  calibrate: createCalibrator(bus, log),
  ...(seller ? { escrowSeller: seller.sellerAddress } : {}),
});
// The run button. The UI hub is created after the server starts; until then nobody listens.
let notifyDemo = () => {};
const demo = new DemoController({
  agentUrl: env.AGENT_URL,
  agentToken: env.AGENT_TOKEN,
  cooldownSec: env.DEMO_COOLDOWN_SEC,
  dailyRuns: env.DEMO_DAILY_RUNS,
  bus,
  log,
  onChange: () => notifyDemo(),
  liveRun: (now) => runs.liveRun(now),
});
const sellers = Object.fromEntries(
  (["A", "B", "C"] as const).flatMap((id) => {
    const address = env[`SELLER_${id}_ADDRESS`];
    return address ? [[id, address]] : [];
  }),
);

const app = createApp({
  version: PEKKAH_VERSION,
  sha,
  webDist,
  workersOnline: () => registry.online(),
  routes: (app) => {
    app.get("/api/workers", (_req, res) => {
      res.json(registry.snapshots());
    });
    registerQuoteRoute(app, {
      workers: () => registry.snapshots(),
      offers,
      bus,
      asset: env.PEKKAH_ASSET,
      log,
    });
    // Registered directly on app, with the payment gate in the route's own chain (fact 11).
    registerPaidJobRoute(app, {
      ...payments,
      offers,
      jobs,
      registry,
      bus,
      l1Confirmations: env.L1_CONFIRMATIONS,
      log,
      // POST /api/escrow-jobs/:offerId only with a seller key that derives SELLER_A_ADDRESS.
      ...(seller
        ? { masumi: { sellerAddress: seller.sellerAddress, asset: env.PEKKAH_ASSET } }
        : {}),
    });
    registerReadRoutes(app, { jobs, runs, facilitatorUrl: env.FACILITATOR_URL, log });
    registerAgentEvents(app, bearerGuard(env.AGENT_TOKEN), bus);
    registerDemoRoute(app, demo, env.DEMO_TOKEN);
    if (env.PEKKAH_DEV_ROUTES && env.DEMO_TOKEN) {
      const guard = bearerGuard(env.DEMO_TOKEN);
      const common = {
        ...payments,
        asset: env.PEKKAH_ASSET,
        l1Confirmations: env.L1_CONFIRMATIONS,
        log,
      };
      registerSmokeRoute(app, guard, { ...common, sellers });
      registerDevDispatchRoutes(app, guard, { registry, log });
      if (seller) registerSmokeEscrowRoute(app, guard, common);
    }
  },
});

const server = app.listen(env.MARKET_PORT, () => {
  log.info(
    {
      port: env.MARKET_PORT,
      sha,
      web: existsSync(webDist),
      devRoutes: env.PEKKAH_DEV_ROUTES,
      sellers: Object.keys(sellers),
      masumi: seller ? { seller: seller.sellerAddress } : false,
      facilitator: env.FACILITATOR_URL,
    },
    "market listening",
  );
});
registry.attach(server);
const ui = new UiHub({
  bus,
  workers: () => registry.snapshots(),
  onWorkersChange: (listener) => registry.onChange(listener),
  demo: () => demo.state(),
  log,
});
ui.attach(server);
notifyDemo = () => ui.demoChanged();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "market stopping");
    demo.close();
    ui.close();
    registry.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
