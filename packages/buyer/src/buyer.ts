import { NETWORK, type TransferMethod, usdToAtomic } from "@pekkah/protocol";
import { assertMnemonic } from "@pekkah/runtime";
import { decodeCardanoTransaction, toClientCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { Agent, setGlobalDispatcher } from "undici";
import {
  addressBalance,
  type Balance,
  type BlockfrostConfig,
  type TxSighting,
  waitForTx,
} from "./blockfrost.js";
import { check402, type PaymentExpectation } from "./check.js";
import { SpendLedger } from "./ledger.js";
import { PaymentMutex } from "./mutex.js";

// A paid request can take a job of up to 120 s plus a settlement of up to ~160 s, so every
// HTTP wait in the buyer's process gets 600 s (PLAN 4.1, fact 9). Node's global fetch honours
// this dispatcher.
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));

export interface BuyerConfig {
  mnemonic: string;
  accountIndex?: number;
  blockfrost: BlockfrostConfig;
  /** PEKKAH_ASSET. */
  asset: string;
  caps: { perPaymentUsd: number; perRunUsd: number; perDayUsd: number };
  onEvent?: (event: BuyerEvent) => void;
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
  /** From PAYMENT-RESPONSE: present only when the payment settled. */
  settle?: SettleResponse;
  durationMs: number;
}

interface Pending {
  expect: PaymentExpectation;
  runId: string;
  offerId?: string;
  txHash?: string;
  paymentHeader?: string;
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
  assertMnemonic("BUYER_MNEMONIC", config.mnemonic);
  try {
    return toClientCardanoSigner({
      mnemonic: config.mnemonic,
      network: NETWORK,
      accountIndex: config.accountIndex ?? 0,
      provider: { blockfrost: config.blockfrost, requestTimeoutMs: 30_000 },
    });
  } catch {
    throw new Error("could not derive the buyer wallet from BUYER_MNEMONIC");
  }
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
    const txHash = txHashOf(paymentPayload);
    pending.txHash = txHash;
    pending.paymentHeader = http.encodePaymentSignatureHeader(paymentPayload)["PAYMENT-SIGNATURE"];
    ledger.record(pending.runId, paymentPayload.accepted.amount);
    try {
      config.onEvent?.({
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
    } catch {
      // Reporting never blocks a payment.
    }
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
          const res = await fetchWithPayment(request.url, {
            method: request.method ?? "POST",
            headers: { "content-type": "application/json", ...request.headers },
            ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
          });
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
            hold(waitForTx(config.blockfrost, current.txHash));
          }
          return {
            status: res.status,
            body,
            ...(current.txHash ? { txHash: current.txHash } : {}),
            ...(current.paymentHeader ? { paymentHeader: current.paymentHeader } : {}),
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

function txHashOf(paymentPayload: PaymentPayload): string {
  return decodeCardanoTransaction(String(paymentPayload.payload.transaction)).txHash;
}
