// Pekkah as an MCP server (PLAN, B1): Claude can list the market and buy an image with a
// tool call. It runs on my Mac over stdio; the buyer is the same x402 client as my agent,
// with the same wallet, the same caps and the same 402-matches-offer check.

import "./stdio-guard.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBuyer } from "@pekkah/buyer";
import { AssetId, DEFAULT_ASSET, PEKKAH_VERSION } from "@pekkah/protocol";
import { readEnv, redact } from "@pekkah/runtime";
import { monotonicFactory } from "ulid";
import { z } from "zod";
import { type Deps, GenerateImageInput, generateImage, marketText } from "./pekkah.js";

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

server.registerTool(
  "pekkah_generate_image",
  {
    title: "Buy an image on Pekkah",
    description:
      "Buys one 1024x1024 image from a GPU worker on Pekkah. My agent quotes the market, takes an offer at or below maxUsd, and pays per job with x402 in test tUSDM on Cardano preprod, only after the image is delivered (a failed job charges nothing). Returns the image and a receipt with the transaction link.",
    inputSchema: GenerateImageInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (input) => {
    log("generate image", { maxUsd: input.maxUsd, promptChars: input.prompt.length });
    try {
      return await generateImage(input, deps);
    } catch (err) {
      log("generate image failed", { error: err instanceof Error ? err.message : String(err) });
      return {
        content: [
          {
            type: "text",
            text: `Pekkah failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

await server.connect(new StdioServerTransport());
log("ready", { market: marketUrl, buyer: buyer.address, events: Boolean(env.AGENT_TOKEN) });
