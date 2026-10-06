import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { masumiSeller } from "@pekkah/payments";
import { AssetId, CardanoAddress, DEFAULT_ASSET, PEKKAH_VERSION } from "@pekkah/protocol";
import { createLogger, envFlag, envPort, gitSha, readEnv } from "@pekkah/runtime";
import { z } from "zod";
import { createApp } from "./app.js";
import { bearerGuard, registerSmokeEscrowRoute, registerSmokeRoute } from "./dev.js";
import { EventBus } from "./events.js";
import { createMarketPayments } from "./payments.js";

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
const payments = createMarketPayments(
  {
    facilitatorUrl: env.FACILITATOR_URL,
    timeoutMs: env.FACILITATOR_TIMEOUT_MS,
    ...(seller ? { masumi: { seller } } : {}),
  },
  bus,
  log,
);
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
  workersOnline: () => 0,
  routes: (app) => {
    if (env.PEKKAH_DEV_ROUTES && env.DEMO_TOKEN) {
      const guard = bearerGuard(env.DEMO_TOKEN);
      const common = {
        ...payments,
        asset: env.PEKKAH_ASSET,
        l1Confirmations: env.L1_CONFIRMATIONS,
        log,
      };
      registerSmokeRoute(app, guard, { ...common, sellers });
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "market stopping");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
