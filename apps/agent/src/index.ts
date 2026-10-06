import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createBuyer } from "@pekkah/buyer";
import {
  AgentRunRequest,
  AssetId,
  DEFAULT_ASSET,
  explorerTxUrl,
  IMAGE_PROMPTS,
  PEKKAH_VERSION,
  RUN_ID_HEADER,
  ScenarioName,
} from "@pekkah/protocol";
import { createLogger, envPort, gitSha, readEnv } from "@pekkah/runtime";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import { MarketClient } from "./market.js";
import { runScenario, type SavedPayment } from "./run.js";

const usd = z.coerce.number().positive();
const env = readEnv("agent", {
  AGENT_MODE: z.enum(["cli", "service"]).default("cli"),
  AGENT_PORT: envPort(4100),
  MARKET_URL: z.string().url().default("http://127.0.0.1:8080"),
  AGENT_TOKEN: z.string().min(16).optional(),
  BUYER_MNEMONIC: z.string().min(1),
  BUYER_ACCOUNT_INDEX: z.coerce.number().int().min(0).default(0),
  BLOCKFROST_PROJECT_ID: z.string().min(1),
  BLOCKFROST_BASE_URL: z.string().url().default("https://cardano-preprod.blockfrost.io/api/v0"),
  PEKKAH_ASSET: AssetId.default(DEFAULT_ASSET),
  CAP_PER_PAYMENT_USD: usd.default(0.1),
  CAP_RUN_USD: usd.default(0.2),
  CAP_DAY_USD: usd.default(5),
});
const log = createLogger("agent");
const LAST_PAYMENT = join(homedir(), ".pekkah", "last-payment.json");
const nextRunId = monotonicFactory();

function sameToken(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, createHash("sha256").update(expected).digest());
}

/**
 * Service mode (PR-06b): the market hands runs to POST /run (Bearer AGENT_TOKEN). One run at a
 * time; the buyer's caps hold across runs, and its mutex keeps one payment in flight.
 */
function serve(): void {
  const token = env.AGENT_TOKEN;
  if (!token) {
    console.error("agent: env missing AGENT_TOKEN (service mode needs it)");
    process.exit(1);
  }
  const { market, buyer } = connect(env.MARKET_URL);
  let current: string | null = null;
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") {
      return send(200, { ok: true, sha: gitSha(), running: current });
    }
    if (req.method !== "POST" || req.url !== "/run") return send(404, { error: "not_found" });
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !sameToken(auth.slice(7), token)) {
      return send(401, { error: "unauthorized" });
    }
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk;
      if (raw.length > 4096) req.destroy();
    });
    req.on("end", () => {
      let parsed: ReturnType<typeof AgentRunRequest.safeParse>;
      try {
        parsed = AgentRunRequest.safeParse(JSON.parse(raw));
      } catch {
        return send(400, { error: "invalid_request" });
      }
      if (!parsed.success) return send(400, { error: "invalid_request" });
      if (current) return send(409, { error: "run_in_progress", runId: current });
      const { scenario, runId, promptIndex } = parsed.data;
      current = runId;
      send(202, { runId });
      runScenario({
        scenario,
        runId,
        ...(promptIndex !== undefined ? { promptIndex } : {}),
        buyer,
        market,
        print: (line) => log.info({ runId }, line),
      })
        .catch(async (err) => {
          log.error({ runId, err: err instanceof Error ? err.message : err }, "run crashed");
          await market.event(
            "run.failed",
            { reason: "the agent stopped with an error" },
            { runId },
          );
        })
        .finally(() => {
          current = null;
        });
    });
  });
  server.listen(env.AGENT_PORT, () =>
    log.info({ port: env.AGENT_PORT }, "agent service listening"),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

function connect(marketUrl: string) {
  const market = new MarketClient(marketUrl.replace(/\/+$/, ""), env.AGENT_TOKEN, (m) =>
    log.warn(m),
  );
  try {
    const buyer = createBuyer({
      mnemonic: env.BUYER_MNEMONIC,
      accountIndex: env.BUYER_ACCOUNT_INDEX,
      blockfrost: { baseUrl: env.BLOCKFROST_BASE_URL, projectId: env.BLOCKFROST_PROJECT_ID },
      asset: env.PEKKAH_ASSET,
      caps: {
        perPaymentUsd: env.CAP_PER_PAYMENT_USD,
        perRunUsd: env.CAP_RUN_USD,
        perDayUsd: env.CAP_DAY_USD,
      },
      // payment.signed reaches the market before the paid retry does.
      onEvent: (e) => market.event(e.type, e.data, { runId: e.runId }),
    });
    return { market, buyer };
  } catch (err) {
    console.error(`agent: ${err instanceof Error ? err.message : "could not create the buyer"}`);
    process.exit(1);
  }
}

async function cli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { market: { type: "string" }, prompt: { type: "string" } },
    allowPositionals: true,
  });
  const [command, name] = positionals;
  const marketUrl = values.market ?? env.MARKET_URL;

  if (command === "run") {
    const scenario = ScenarioName.safeParse(name);
    if (!scenario.success) {
      console.error(`usage: agent run <${ScenarioName.options.join("|")}> [--market <url>]`);
      return 2;
    }
    const promptIndex = values.prompt === undefined ? undefined : Number(values.prompt);
    if (
      values.prompt !== undefined &&
      (!/^\d+$/.test(values.prompt) || IMAGE_PROMPTS[promptIndex ?? -1] === undefined)
    ) {
      console.error(`usage: --prompt takes 0 to ${IMAGE_PROMPTS.length - 1}`);
      return 2;
    }
    const { market, buyer } = connect(marketUrl);
    const outcome = await runScenario({
      scenario: scenario.data,
      runId: nextRunId(),
      ...(promptIndex !== undefined ? { promptIndex } : {}),
      buyer,
      market,
      print: (line) => console.log(line),
      resultsDir: join(process.cwd(), "results"),
      lastPaymentFile: LAST_PAYMENT,
    });
    await buyer.idle();
    return outcome.ok ? 0 : 1;
  }

  if (command === "replay-last") {
    // The same PAYMENT-SIGNATURE again: the market must answer from its records, with no
    // second job and no second transaction. Plain fetch: the x402 wrapper refuses a request
    // that already carries a payment.
    const saved = JSON.parse(readFileSync(LAST_PAYMENT, "utf8")) as SavedPayment;
    console.log(`replay     ${saved.url} (tx ${saved.txHash}, saved ${saved.savedAt})`);
    const res = await fetch(saved.url, {
      method: "POST",
      headers: { "payment-signature": saved.paymentHeader, [RUN_ID_HEADER]: saved.runId },
      signal: AbortSignal.timeout(600_000),
    });
    const header = res.headers.get("payment-response");
    const settle = header ? decodePaymentResponseHeader(header) : undefined;
    console.log(`HTTP       ${res.status}`);
    console.log(`body       ${await res.text()}`);
    console.log(
      `receipt    ${settle ? `${settle.success} ${explorerTxUrl(settle.transaction)}` : "none"}`,
    );
    return res.ok && settle?.transaction === saved.txHash ? 0 : 1;
  }

  console.log(`Pekkah agent ${PEKKAH_VERSION}`);
  console.log("usage: agent run <scenario> [--market <url>] [--prompt <0-4>] | agent replay-last");
  return command ? 2 : 0;
}

if (env.AGENT_MODE === "service") {
  serve();
} else {
  process.exit(await cli(process.argv.slice(2)));
}
