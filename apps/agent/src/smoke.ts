import { parseArgs } from "node:util";
import { createBuyer, type PaymentExpectation } from "@pekkah/buyer";
import {
  AssetId,
  CardanoAddress,
  DEFAULT_ASSET,
  explorerTxUrl,
  formatAtomic,
  formatLovelace,
  MASUMI_LOCK_LABEL,
  NETWORK,
} from "@pekkah/protocol";
import { readEnv } from "@pekkah/runtime";
import { decodeCardanoTransaction, masumiEscrowAddress } from "@x402/cardano";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { z } from "zod";

// pnpm --filter @pekkah/agent smoke --seller B [--fail]
//   A real $0.01 tUSDM x402 payment through the market's dev smoke route (PR-02). With --fail
//   the route answers 500 after verify, so nothing may be charged.
// pnpm --filter @pekkah/agent smoke --escrow
//   The Masumi feasibility gate (PR-02m): $0.01 locked in Masumi's escrow with worker A as
//   seller. Locked, never released: release, refund and dispute tooling is my next step.

const { values } = parseArgs({
  options: {
    seller: { type: "string" },
    fail: { type: "boolean", default: false },
    escrow: { type: "boolean", default: false },
    market: { type: "string" },
  },
  strict: true,
});
const seller = values.escrow ? "A" : values.seller?.toUpperCase();
if (seller !== "A" && seller !== "B" && seller !== "C") {
  console.error("usage: smoke --seller A|B|C [--fail] | smoke --escrow   [--market <url>]");
  process.exit(2);
}

const usd = z.coerce.number().positive();
const env = readEnv("agent smoke", {
  MARKET_URL: z.string().url().default("http://127.0.0.1:8080"),
  BUYER_MNEMONIC: z.string().min(1),
  BUYER_ACCOUNT_INDEX: z.coerce.number().int().min(0).default(0),
  BLOCKFROST_PROJECT_ID: z.string().min(1),
  BLOCKFROST_BASE_URL: z.string().url().default("https://cardano-preprod.blockfrost.io/api/v0"),
  PEKKAH_ASSET: AssetId.default(DEFAULT_ASSET),
  CAP_PER_PAYMENT_USD: usd.default(0.1),
  CAP_RUN_USD: usd.default(0.2),
  CAP_DAY_USD: usd.default(5),
  DEMO_TOKEN: z.string().min(16),
  SELLER_A_ADDRESS: CardanoAddress.optional(),
  SELLER_B_ADDRESS: CardanoAddress.optional(),
  SELLER_C_ADDRESS: CardanoAddress.optional(),
});
const sellerAddress = env[`SELLER_${seller}_ADDRESS`];
if (!sellerAddress) {
  console.error(`agent smoke: env missing SELLER_${seller}_ADDRESS`);
  process.exit(1);
}
const market = (values.market ?? env.MARKET_URL).replace(/\/+$/, "");
const escrow = masumiEscrowAddress(NETWORK);

const buyer = (() => {
  try {
    return createBuyerFromEnv();
  } catch (err) {
    console.error(
      `agent smoke: ${err instanceof Error ? err.message : "could not create the buyer"}`,
    );
    process.exit(1);
  }
})();

function createBuyerFromEnv() {
  return createBuyer({
    mnemonic: env.BUYER_MNEMONIC,
    accountIndex: env.BUYER_ACCOUNT_INDEX,
    blockfrost: { baseUrl: env.BLOCKFROST_BASE_URL, projectId: env.BLOCKFROST_PROJECT_ID },
    asset: env.PEKKAH_ASSET,
    caps: {
      perPaymentUsd: env.CAP_PER_PAYMENT_USD,
      perRunUsd: env.CAP_RUN_USD,
      perDayUsd: env.CAP_DAY_USD,
    },
    onEvent: (e) => console.log(`signed     ${e.data.txHash} → ${e.data.payTo}`),
  });
}

const show = (b: { lovelace: string; assetAtomic: string }) =>
  `${formatAtomic(b.assetAtomic)} tUSDM, ${formatLovelace(b.lovelace)}`;
const time = (posixMs: unknown) => new Date(Number(posixMs)).toISOString();

console.log(`buyer      ${buyer.address}`);
console.log(`seller ${seller}   ${sellerAddress}`);
if (values.escrow) console.log(`escrow     ${escrow}`);
const before = await buyer.balance();
console.log(`balance    ${show(before)}`);

const url = values.escrow
  ? `${market}/api/dev/smoke-escrow`
  : `${market}/api/dev/smoke/${seller}${values.fail ? "?fail=1" : ""}`;
const expect: Omit<PaymentExpectation, "asset"> = values.escrow
  ? { transferMethod: "masumi", payTo: escrow, seller: sellerAddress, amountAtomic: "10000" }
  : { payTo: sellerAddress, amountAtomic: "10000" };
console.log(`POST       ${url}`);
const result = await buyer.buy({
  url,
  headers: { authorization: `Bearer ${env.DEMO_TOKEN}` },
  body: { note: "pekkah smoke", seller, at: new Date().toISOString() },
  expect,
  runId: `smoke-${Date.now()}`,
});

console.log(`HTTP       ${result.status} after ${(result.durationMs / 1000).toFixed(1)} s`);
console.log(`txHash     ${result.txHash ?? "(no payment signed)"}`);
if (result.txHash) console.log(`explorer   ${explorerTxUrl(result.txHash)}`);
console.log(
  `receipt    ${result.settle ? `PAYMENT-RESPONSE success=${result.settle.success}` : "no PAYMENT-RESPONSE"}`,
);
if (result.refused) {
  console.log(
    `refused    ${result.refused.txHash} (${result.refused.reason}): never broadcast, re-signed once`,
  );
}
console.log(`body       ${JSON.stringify(result.body)}`);

if (values.escrow && result.accepted && result.paymentHeader) {
  const terms = (result.accepted.extra.terms ?? {}) as Record<string, unknown>;
  const tx = decodeCardanoTransaction(
    String(decodePaymentSignatureHeader(result.paymentHeader).payload.transaction),
  );
  const lock = tx.outputs.find((o) => o.address === escrow);
  console.log(`status     ${result.settle?.success ? MASUMI_LOCK_LABEL : "not locked"}`);
  console.log(`seller     ${String(terms.sellerAddress)}`);
  console.log(`inputHash  ${String(terms.inputHash)}`);
  console.log(
    `locked     ${formatAtomic(lock?.assets[env.PEKKAH_ASSET] ?? 0n)} tUSDM + ${formatLovelace(lock?.coin ?? 0n)} (collateral and minimum ADA), inline datum ${lock?.datum ? "present" : "missing"}`,
  );
  console.log(`payBy      ${time(terms.payByTime)}`);
  console.log(`submit     ${time(terms.submitResultTime)}`);
  console.log(`unlock     ${time(terms.unlockTime)}`);
  console.log(`dispute    ${time(terms.externalDisputeUnlockTime)}`);
}

if (result.settle?.success && result.txHash) {
  await buyer.idle();
  const seen = await buyer.waitForTx(result.txHash, { timeoutMs: 5_000 });
  console.log(
    `on chain   ${seen.found ? `block ${seen.blockHeight ?? "?"} (${seen.block})` : "not yet visible on Blockfrost"}`,
  );
}
const after = await buyer.balance();
console.log(`balance    ${show(after)}`);
if (values.fail && result.txHash) {
  console.log(
    `ttlSlot    ${result.ttlSlot ?? "?"} (the signed tx can never land from this slot on)`,
  );
  console.log(
    `check      curl -s '<facilitator>/tx/${result.txHash}?ttlSlot=${result.ttlSlot ?? ""}'  (found:false; final:true once the window has closed)`,
  );
}

const ok = values.fail
  ? result.status >= 400 && !result.settle
  : result.status === 200 && result.settle?.success === true;
process.exit(ok ? 0 : 1);
