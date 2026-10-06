import { createServer } from "node:http";
import { PEKKAH_VERSION } from "@pekkah/protocol";
import { createLogger, envPort, gitSha, readEnv } from "@pekkah/runtime";
import { z } from "zod";

// Skeleton. PR-02 adds the smoke command, PR-06 the scenario runner and CLI, PR-06b the
// service mode's POST /run.

const env = readEnv("agent", {
  AGENT_MODE: z.enum(["cli", "service"]).default("cli"),
  AGENT_PORT: envPort(4100),
});
const log = createLogger("agent");

if (env.AGENT_MODE === "service") {
  const server = createServer((req, res) => {
    const ok = req.method === "GET" && req.url === "/health";
    res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, sha: gitSha() } : { error: "not_found" }));
  });
  server.listen(env.AGENT_PORT, () =>
    log.info({ port: env.AGENT_PORT }, "agent service listening"),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
} else {
  console.log(
    `Pekkah agent ${PEKKAH_VERSION}. No commands yet: smoke lands in PR-02, run in PR-06.`,
  );
}
