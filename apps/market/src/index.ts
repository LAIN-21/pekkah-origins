import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PEKKAH_VERSION } from "@pekkah/protocol";
import { createLogger, envPort, gitSha, readEnv } from "@pekkah/runtime";
import { createApp } from "./app.js";

const env = readEnv("market", { MARKET_PORT: envPort(8080) });
const log = createLogger("market");
const sha = gitSha();
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));

const app = createApp({ version: PEKKAH_VERSION, sha, webDist, workersOnline: () => 0 });
const server = app.listen(env.MARKET_PORT, () => {
  log.info({ port: env.MARKET_PORT, sha, web: existsSync(webDist) }, "market listening");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "market stopping");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
