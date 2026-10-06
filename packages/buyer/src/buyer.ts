import { NETWORK, type TransferMethod, usdToAtomic } from "@pekkah/protocol";
import { assertMnemonic } from "@pekkah/runtime";
import {
  decodeCardanoTransaction,
  ERR_CHAIN_LOOKUP_FAILED,
  ERR_INPUT_NOT_AVAILABLE,
  ERR_NONCE_NOT_ON_CHAIN,
  toClientCardanoSigner,
} from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { Agent, setGlobalDispatcher } from "undici";
import {
  addressBalance,
  type Balance,
  type BlockfrostConfig,
  type TxSighting,
  waitForSettled,
  waitForTx,
} from "./blockfrost.js";
import { check402, type PaymentExpectation } from "./check.js";
import { SpendLedger } from "./ledger.js";
import { PaymentMutex } from "./mutex.js";

// A paid request can take a job of up to 120 s plus a settlement of up to ~160 s, so every
// HTTP wait in the buyer's process gets 600 s (PLAN 4.1, fact 9). Node's global fetch honours
// this dispatcher.
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));

/** Verify refusals that mean the chain view was stale; a refused payment is never broadcast. */
const STALE_VIEW = new Set([
  ERR_NONCE_NOT_ON_CHAIN,
  ERR_INPUT_NOT_AVAILABLE,
  ERR_CHAIN_LOOKUP_FAILED,
]);
const STALE_RETRY_DELAY_MS = 20_000;

export interface BuyerConfig {
  mnemonic: string;
  accountIndex?: number;
  blockfrost: BlockfrostConfig;
  /** PEKKAH_ASSET. */
  asset: string;
  caps: { perPaymentUsd: number; perRunUsd: number; perDayUsd: number };
  /** Awaited (up to 5 s) before the paid retry, so the event lands before the payment does. */
  onEvent?: (event: BuyerEvent) => void | Promise<void>;
}

export interface BuyerEvent {
  type: "payment.signed";
  runId: string;
  data: {
    txHash: string;
    payTo: string;
    amountAtomic: string;
    transferMethod: TransferMethod;
    offerId?: string;
  };
}

export interface BuyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  expect: Omit<PaymentExpectation, "asset"> & { asset?: string };
  runId?: string;
  offerId?: string;
}

export interface BuyResult {
  status: number;
  body: unknown;
  /** Known from the moment the payment is signed. */
  txHash?: string;
  /** The PAYMENT-SIGNATURE header that was sent, for a resumed retry. */
  paymentHeader?: string;
  /** The signed transaction's TTL: from this slot on it can never land. */
  ttlSlot?: string;
  /** The requirements the agent signed against (for Masumi, the seller-signed terms). */
  accepted?: PaymentRequirements;
  /** From PAYMENT-RESPONSE: present only when the payment settled. */
  settle?: SettleResponse;
  /** A first signature the facilitator refused on a stale chain view; it was never broadcast. */
  refused?: { txHash: string; reason: string };
  durationMs: number;
}

interface Pending {
  expect: PaymentExpectation;
  runId: string;
  offerId?: string;
  txHash?: string;
  paymentHeader?: string;
  ttlSlot?: string;
  inputs?: string[];
  refused?: { txHash: string; reason: string };
  accepted?: PaymentRequirements;
}

export interface Buyer {
  address: string;
  buy(request: BuyRequest): Promise<BuyResult>;
  balance(): Promise<Balance>;
  waitForTx(txHash: string, options?: { timeoutMs?: number }): Promise<TxSighting>;
  /** Resolves when no payment is in flight and the last settled tx is visible on chain. */
  idle(): Promise<void>;
}

function buyerSigner(config: BuyerConfig) {
  // Checked first: the wallet library would put an unknown word in its error message.
  const mnemonic = assertMnemonic("BUYER_MNEMONIC", config.mnemonic);
  try {
    return toClientCardanoSigner({
      mnemonic,
      network: NETWORK,
      accountIndex: config.accountIndex ?? 0,
      provider: { blockfrost: config.blockfrost, requestTimeoutMs: 30_000 },
    });
  } catch {
    throw new Error("could not derive the buyer wallet from BUYER_MNEMONIC");
  }
}

/** Up to 3 more tries with the same PAYMENT-SIGNATURE, 2, 4 and 8 s apart. */
async function resume(url: string, init: RequestInit, paymentHeader: string, first: unknown) {
  let last = first;
  for (const delay of [2_000, 4_000, 8_000]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          "PAYMENT-SIGNATURE": paymentHeader,
        },
      });
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

export function createBuyer(config: BuyerConfig): Buyer {
  const signer = buyerSigner(config);
  const perPayment = usdToAtomic(config.caps.perPaymentUsd);
  const ledger = new SpendLedger({
    perPayment: BigInt(perPayment),
    perRun: BigInt(usdToAtomic(config.caps.perRunUsd)),
    perDay: BigInt(usdToAtomic(config.caps.perDayUsd)),
  });
  const mutex = new PaymentMutex();

  // Spend controls always on: the payment asset only, capped per payment.
  const client = new x402Client().setSpendControls({
    maxAmountPerPayment: `$${config.caps.perPaymentUsd}`,
    allowedAssets: [{ network: NETWORK, asset: config.asset, maxAmountPerPayment: perPayment }],
  });
  client.register(NETWORK, new ExactCardanoScheme(signer));
  const http = new x402HTTPClient(client);
  let pending: Pending | null = null;

  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    if (!pending) return { abort: true, reason: "no payment is expected" };
    const problem =
      check402(selectedRequirements, pending.expect) ??
      ledger.check(pending.runId, selectedRequirements.amount);
    if (problem) return { abort: true, reason: problem };
  });

  client.onAfterPaymentCreation(async ({ paymentPayload }) => {
    if (!pending) return;
    const tx = decodeCardanoTransaction(String(paymentPayload.payload.transaction));
    const txHash = tx.txHash;
    pending.txHash = txHash;
    pending.inputs = tx.inputs;
    if (tx.ttlSlot !== undefined) pending.ttlSlot = tx.ttlSlot.toString();
    pending.accepted = structuredClone(paymentPayload.accepted);
    pending.paymentHeader = http.encodePaymentSignatureHeader(paymentPayload)["PAYMENT-SIGNATURE"];
    ledger.record(pending.runId, paymentPayload.accepted.amount);
    try {
      const reported = config.onEvent?.({
        type: "payment.signed",
        runId: pending.runId,
        data: {
          txHash,
          payTo: paymentPayload.accepted.payTo,
          amountAtomic: paymentPayload.accepted.amount,
          transferMethod: pending.expect.transferMethod ?? "default",
          ...(pending.offerId ? { offerId: pending.offerId } : {}),
        },
      });
      if (reported) {
        await Promise.race([reported, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      }
    } catch {
      // Reporting never blocks a payment.
    }
  });

  // A refusal on a stale chain view: wait for the views to agree, then re-sign once with
  // fresh UTXOs. The x402 fetch wrapper retries at most once.
  client.onPaymentResponse(async (ctx) => {
    const reason = ctx.paymentRequired?.error;
    if (!pending || pending.refused || ctx.settleResponse || !reason || !STALE_VIEW.has(reason)) {
      return;
    }
    pending.refused = { txHash: pending.txHash ?? "", reason };
    await new Promise((resolve) => setTimeout(resolve, STALE_RETRY_DELAY_MS));
    return { recovered: true };
  });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  return {
    address: signer.getAddress(),

    buy(request) {
      return mutex.run(async (hold) => {
        const started = Date.now();
        pending = {
          expect: { ...request.expect, asset: request.expect.asset ?? config.asset },
          runId: request.runId ?? "adhoc",
          ...(request.offerId ? { offerId: request.offerId } : {}),
        };
        const current = pending;
        try {
          const init: RequestInit = {
            method: request.method ?? "POST",
            headers: { "content-type": "application/json", ...request.headers },
            ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
          };
          let res: Response;
          try {
            res = await fetchWithPayment(request.url, init);
          } catch (err) {
            // A network error after signing: re-send the same payment, which the market
            // answers from its records (one job, one transaction per txHash).
            if (!current.paymentHeader) throw err;
            res = await resume(request.url, init, current.paymentHeader, err);
          }
          let settle: SettleResponse | undefined;
          try {
            settle = http.getPaymentSettleResponse((name) => res.headers.get(name));
          } catch {
            settle = undefined;
          }
          const text = await res.text();
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : undefined;
          } catch {
            body = text;
          }
          if (settle?.success && current.txHash) {
            const address = signer.getAddress();
            hold(waitForSettled(config.blockfrost, address, current.txHash, current.inputs ?? []));
          }
          return {
            status: res.status,
            body,
            ...(current.txHash ? { txHash: current.txHash } : {}),
            ...(current.paymentHeader ? { paymentHeader: current.paymentHeader } : {}),
            ...(current.ttlSlot ? { ttlSlot: current.ttlSlot } : {}),
            ...(current.refused ? { refused: current.refused } : {}),
            ...(current.accepted ? { accepted: current.accepted } : {}),
            ...(settle ? { settle } : {}),
            durationMs: Date.now() - started,
          };
        } finally {
          pending = null;
        }
      });
    },

    balance: () => addressBalance(config.blockfrost, signer.getAddress(), config.asset),
    waitForTx: (txHash, options) => waitForTx(config.blockfrost, txHash, options),
    idle: () => mutex.idle(),
  };
}
