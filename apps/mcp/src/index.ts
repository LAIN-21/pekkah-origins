// Pekkah as an MCP server (PLAN, B1): Claude can list the market and buy an image with a
// tool call. It runs on my Mac over stdio; the buyer is the same x402 client as my agent,
// with the same wallet, the same caps and the same 402-matches-offer check.

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

const deps: Deps = {
  marketUrl,
  asset: env.PEKKAH_ASSET,
  buyer,
  newRunId: monotonicFactory(),
  emit,
};

const server = new McpServer({ name: "pekkah", version: PEKKAH_VERSION });

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

server.registerTool(
  "pekkah_get_image",
  {
    title: "Get a Pekkah image",
    description:
      "Gets the image and receipt of a purchase that pekkah_generate_image started, by its run id. Waits up to about 45 s. Buys nothing.",
    inputSchema: {
      runId: z.string().min(1).max(64).describe("The run id pekkah_generate_image returned."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ runId }, extra) => {
    if (!book.has(runId)) {
      return {
        content: [
          { type: "text", text: `No purchase with run id "${runId}" since this server started.` },
        ],
        isError: true,
      };
    }
    return (await book.wait(runId, progress(extra))) ?? pendingResult(runId);
  },
);

await server.connect(new StdioServerTransport());
log("ready", { market: marketUrl, buyer: buyer.address, events: Boolean(env.AGENT_TOKEN) });
