import { type FacilitatorHealth, NETWORK } from "@pekkah/protocol";
import { createLogger, envPort, readEnv } from "@pekkah/runtime";
import express from "express";
import { z } from "zod";

// Skeleton. PR-02 ports the MIT starter's facilitator (verify, settle, supported, tx status).

const env = readEnv("facilitator", {
  FACILITATOR_HOST: z.string().default("127.0.0.1"),
  FACILITATOR_PORT: envPort(4022),
  CONFIRMATION_TIMEOUT_MS: z.coerce.number().int().positive().default(75_000),
});
const log = createLogger("facilitator");

const app = express();
app.set("case sensitive routing", true);
app.set("strict routing", true);
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  const body: FacilitatorHealth = {
    ok: true,
    network: NETWORK,
    confirmationTimeoutMs: env.CONFIRMATION_TIMEOUT_MS,
  };
  res.json(body);
});

const server = app.listen(env.FACILITATOR_PORT, env.FACILITATOR_HOST, () => {
  log.info({ host: env.FACILITATOR_HOST, port: env.FACILITATOR_PORT }, "facilitator listening");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
