import { NETWORK } from "@pekkah/protocol";
import { createLogger, envFlag, envPort, readEnv } from "@pekkah/runtime";
import { toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import { z } from "zod";
import { createFacilitatorApp } from "./app.js";
import { lookupTx } from "./blockfrost.js";

const env = readEnv("facilitator", {
  BLOCKFROST_PROJECT_ID: z.string().min(1),
  BLOCKFROST_BASE_URL: z.string().url().default("https://cardano-preprod.blockfrost.io/api/v0"),
  // Loopback by default: every /verify and /settle spends Blockfrost quota. Compose sets
  // 0.0.0.0 inside its network; the port is never published.
  FACILITATOR_HOST: z.string().default("127.0.0.1"),
  FACILITATOR_PORT: envPort(4022),
  CONFIRMATION_TIMEOUT_MS: z.coerce.number().int().positive().default(75_000),
  ACCEPT_MEMPOOL: envFlag,
});
const log = createLogger("facilitator");
const blockfrost = { baseUrl: env.BLOCKFROST_BASE_URL, projectId: env.BLOCKFROST_PROJECT_ID };

const signer = toFacilitatorCardanoSigner({
  network: NETWORK,
  provider: { blockfrost },
  awaitConfirmation: false,
});
const facilitator = new x402Facilitator();
facilitator.register(
  NETWORK,
  new ExactCardanoScheme(signer, {
    confirmationTimeoutMs: env.CONFIRMATION_TIMEOUT_MS,
    confirmationPollMs: 5_000,
    acceptMempool: env.ACCEPT_MEMPOOL,
  }),
);

const app = createFacilitatorApp({
  facilitator,
  confirmationTimeoutMs: env.CONFIRMATION_TIMEOUT_MS,
  lookupTx: (hash, ttlSlot) => lookupTx(blockfrost, hash, ttlSlot),
  log,
});

const server = app.listen(env.FACILITATOR_PORT, env.FACILITATOR_HOST, () => {
  log.info(
    { host: env.FACILITATOR_HOST, port: env.FACILITATOR_PORT, network: NETWORK },
    "facilitator listening",
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
