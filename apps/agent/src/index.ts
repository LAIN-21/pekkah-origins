import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createBuyer } from "@pekkah/buyer";
import {
  AssetId,
  DEFAULT_ASSET,
  explorerTxUrl,
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
    const { market, buyer } = connect(marketUrl);
    const outcome = await runScenario({
      scenario: scenario.data,
      runId: nextRunId(),
      ...(values.prompt !== undefined ? { promptIndex: Number(values.prompt) } : {}),
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
  // PR-06b adds POST /run.
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
  process.exit(await cli(process.argv.slice(2)));
}
