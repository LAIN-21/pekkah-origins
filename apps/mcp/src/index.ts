// Pekkah as an MCP server (PLAN, B1; PLAN2 PR-14): Claude looks at the market, gets quotes,
// keeps to my budget, asks me before paying more, and buys. It runs on my Mac over stdio; the
// buyer is the same x402 client as my agent, with its own account, its own caps and the same
// 402-matches-offer check.

import "./stdio-guard.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { createBuyer } from "@pekkah/buyer";
import { AssetId, DEFAULT_ASSET, PEKKAH_VERSION } from "@pekkah/protocol";
import { readEnv, redact } from "@pekkah/runtime";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import {
  type Deps,
  GenerateImageInput,
  marketText,
  PurchaseBook,
  pendingResult,
} from "./pekkah.js";
import { BuyInput, QuoteInput, ResultInput, Shop } from "./shop.js";

const usd = z.coerce.number().positive();
const env = readEnv("mcp", {
  MARKET_URL: z.string().url(),
  BUYER_MNEMONIC: z.string().min(1),
  BUYER_ACCOUNT_INDEX: z.coerce.number().int().min(0).default(0),
  BLOCKFROST_PROJECT_ID: z.string().min(1),
  BLOCKFROST_BASE_URL: z.string().url().default("https://cardano-preprod.blockfrost.io/api/v0"),
  PEKKAH_ASSET: AssetId.default(DEFAULT_ASSET),
  CAP_PER_PAYMENT_USD: usd.max(0.1).default(0.1),
  CAP_DAY_USD: usd.default(1),
  /** Optional: with it, the market's page shows these runs as my agent's. */
  AGENT_TOKEN: z.string().min(16).optional(),
  /** Optional: where the full PNGs are saved. */
  PEKKAH_OUTPUT_DIR: z.string().min(1).optional(),
});
const marketUrl = env.MARKET_URL.replace(/\/+$/, "");

function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify(redact({ level: "info", name: "mcp", msg, ...fields })));
}

const emit: NonNullable<Deps["emit"]> = async (type, data, ids) => {
  if (!env.AGENT_TOKEN) return;
  try {
    const res = await fetch(`${marketUrl}/api/agent-events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.AGENT_TOKEN}` },
      body: JSON.stringify({ events: [{ type, data, ...ids }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log("agent event refused", { type, status: res.status });
  } catch (err) {
    log("agent event not delivered", {
      type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

const buyer = createBuyer({
  mnemonic: env.BUYER_MNEMONIC,
  accountIndex: env.BUYER_ACCOUNT_INDEX,
  blockfrost: { baseUrl: env.BLOCKFROST_BASE_URL, projectId: env.BLOCKFROST_PROJECT_ID },
  asset: env.PEKKAH_ASSET,
  // One image per call: a run never needs more than one payment.
  caps: {
    perPaymentUsd: env.CAP_PER_PAYMENT_USD,
    perRunUsd: env.CAP_PER_PAYMENT_USD,
    perDayUsd: env.CAP_DAY_USD,
  },
  onEvent: (event) => emit(event.type, event.data, { runId: event.runId }),
});

/** The shopping policy, short. The full one is the skill in apps/mcp/skill/pekkah. */
const INSTRUCTIONS = `Pekkah is a market where machines sell compute per job: images on a GPU, renders on a CPU. My agent pays in test tUSDM on Cardano preprod, and only after the job delivers.
How to shop:
1. Call pekkah_market, then pekkah_quote with the job and the budget your human gave (budgetUsd). Quotes are free.
2. If an offer fits the budget, buy it with pekkah_buy without asking.
3. If nothing fits, ask your human in one line, naming the price and the worker, for example "I found it for 5 cents on worker A, OK?". Buy only after a yes, with overBudgetApproved: true.
4. If your human gave no budget, ask for one before buying. Quoting first is fine.
5. Prefer escrow: pekkah_buy uses it by default when the worker sells through escrow.
6. Get the result with pekkah_result. Say "locked in escrow" until pekkah_result shows the release, and give the transaction links.`;

const server = new McpServer(
  { name: "pekkah", version: PEKKAH_VERSION },
  { instructions: INSTRUCTIONS },
);

/** Who starts the runs, as the market's page shows it. */
function client(): string {
  const name = server.server.getClientVersion()?.name ?? "";
  if (/claude/i.test(name)) return "Claude via MCP";
  return (name ? `${name} via MCP` : "An MCP client").slice(0, 40);
}

const deps: Deps = {
  marketUrl,
  asset: env.PEKKAH_ASSET,
  buyer,
  newRunId: monotonicFactory(),
  client,
  emit,
};

server.registerTool(
  "pekkah_market",
  {
    title: "Pekkah market",
    description:
      "Lists the machines selling compute on Pekkah right now: hardware, measured speed, prices per job, and status. Free; nothing is bought.",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => marketText(deps),
);

const book = new PurchaseBook(deps);

/** Progress notifications keep the call alive in clients that reset their timeout on them. */
function progress(extra: RequestHandlerExtra<ServerRequest, ServerNotification>) {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  return (waitedSec: number) =>
    extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: waitedSec,
        message: `Waiting for the image and the payment to settle (${waitedSec} s)`,
      },
    });
}

server.registerTool(
  "pekkah_generate_image",
  {
    title: "Buy an image on Pekkah",
    description:
      "Buys one 1024x1024 image from a GPU worker on Pekkah. My agent quotes the market, takes an offer at or below maxUsd, and pays per job with x402 in test tUSDM on Cardano preprod, only after the image is delivered (a failed job charges nothing). Returns the image and a receipt with the transaction link. If the payment is still settling after about 45 s, it returns a run id instead: then call pekkah_get_image with it.",
    inputSchema: GenerateImageInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (input, extra) => {
    const runId = book.start(input);
    log("generate image", { runId, maxUsd: input.maxUsd, promptChars: input.prompt.length });
    return (await book.wait(runId, progress(extra))) ?? pendingResult(runId);
  },
);

const shop = new Shop({
  ...deps,
  buyer,
  capUsd: env.CAP_PER_PAYMENT_USD,
  client,
  ...(env.PEKKAH_OUTPUT_DIR ? { outputDir: env.PEKKAH_OUTPUT_DIR } : {}),
});

server.registerTool(
  "pekkah_quote",
  {
    title: "Get a quote on Pekkah",
    description:
      "Asks the Pekkah market for offers on one job: an image (prompt, size, steps, seed) or a CPU render (preset), with a deadline and the budget your human gave. Free: nothing is bought. Returns each offer (offerId, worker, hardware as the machine reports it, price, estimate, seconds it stays valid, whether Masumi escrow is available), the counter-offer and the market price, every rejected worker with its reason, and a one-line hint. The first quote starts a task and returns its runId; pass that runId to quote again in the same task.",
    inputSchema: QuoteInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (input) => {
    log("quote", { workload: input.workload, budgetUsd: input.budgetUsd, runId: input.runId });
    return shop.quote(input);
  },
);

server.registerTool(
  "pekkah_buy",
  {
    title: "Buy an offer on Pekkah",
    description:
      "Buys one offer that pekkah_quote returned. My agent pays with x402 in test tUSDM on Cardano preprod, only after the job delivers (a failed job charges nothing). maxUsd is the most my agent commits to, at most 0.10. If the price is above the budget your human gave, it refuses unless overBudgetApproved is true: set that only after your human said yes to this price. Uses Masumi escrow by default when the worker sells through it. Give your reason in one or two sentences: the market's page shows it. Waits about 45 s; if the job is still running, it returns the runId: then call pekkah_result.",
    inputSchema: BuyInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (input, extra) => {
    const started = shop.buy(input);
    if ("refused" in started) {
      log("buy refused", { offerId: input.offerId, maxUsd: input.maxUsd });
      return started.refused;
    }
    log("buy", {
      runId: started.runId,
      offerId: input.offerId,
      maxUsd: input.maxUsd,
      escrow: input.escrow,
      overBudgetApproved: input.overBudgetApproved,
    });
    return (await shop.result(started.runId, progress(extra))) ?? pendingResult(started.runId);
  },
);

/** pekkah_result, and pekkah_get_image as its older name. */
const result = async (
  { runId }: { runId: string },
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => {
  if (book.has(runId)) return (await book.wait(runId, progress(extra))) ?? pendingResult(runId);
  return (await shop.result(runId, progress(extra))) ?? pendingResult(runId);
};

server.registerTool(
  "pekkah_result",
  {
    title: "Get a Pekkah result",
    description:
      "Gets the result of a purchase by its runId: the image (a JPEG here; the full PNG is linked, and saved when PEKKAH_OUTPUT_DIR is set), the receipt with the transaction link, and for escrow every step the market has seen: locked, result hash submitted, the unlock time, released. Waits up to about 45 s. Buys nothing. Call it again later to see the escrow's later steps.",
    inputSchema: ResultInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  result,
);

server.registerTool(
  "pekkah_get_image",
  {
    title: "Get a Pekkah image",
    description: "The same as pekkah_result, under its older name.",
    inputSchema: ResultInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  result,
);

await server.connect(new StdioServerTransport());
log("ready", {
  market: marketUrl,
  buyer: buyer.address,
  account: env.BUYER_ACCOUNT_INDEX,
  events: Boolean(env.AGENT_TOKEN),
  outputDir: env.PEKKAH_OUTPUT_DIR ?? null,
});
