import { MAX_TIMEOUT_SECONDS, NETWORK, type PaymentReceipt } from "@pekkah/protocol";
import { assertMnemonic } from "@pekkah/runtime";
import { masumiEscrowAddress, toMasumiSellerSigner } from "@x402/cardano";
import {
  assertMasumiTemplate,
  ExactCardanoScheme,
  type MasumiIssueContext,
  type MasumiSellerSigner,
} from "@x402/cardano/exact/server";
import type { DynamicPayTo, DynamicPrice } from "@x402/core/http";
import {
  type FacilitatorClient,
  HTTPFacilitatorClient,
  type HTTPRequestContext,
  type HTTPTransportContext,
  type RouteConfig,
  type VerifiedPaymentCancellationReason,
  x402ResourceServer,
} from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { paymentMiddleware } from "@x402/express";
import type { PaymentOperations } from "./operations.js";
import { buildReceipt } from "./receipt.js";
import { payloadFingerprint, txHashFromPayload } from "./tx.js";

export interface ResourceServerOptions {
  facilitatorUrl?: string;
  /** Must exceed the facilitator's own confirmation wait by at least 15 s (PLAN 4.1, fact 9). */
  timeoutMs?: number;
  /** Tests pass an in-process facilitator. */
  facilitator?: FacilitatorClient;
  /**
   * Enables Masumi routes. One scheme instance serves both methods: `default` payments behave
   * exactly as without it, and the quote store is only used by Masumi routes.
   */
  masumi?: {
    seller: MasumiSellerSigner;
    /** What the escrow binds to; the library default commits to the resource URL. */
    commitment?: (context: MasumiIssueContext) => MasumiCommitmentPart[];
  };
}

export interface MasumiCommitmentPart {
  name: string;
  canonicalization: "jcs" | "raw";
  mediaType?: string;
  content: unknown;
}

export function createResourceServer(options: ResourceServerOptions): x402ResourceServer {
  const facilitator =
    options.facilitator ??
    new HTTPFacilitatorClient({
      url: options.facilitatorUrl,
      timeoutMs: options.timeoutMs ?? 120_000,
    });
  const scheme = options.masumi
    ? new ExactCardanoScheme({
        masumi: {
          seller: options.masumi.seller,
          ...(options.masumi.commitment ? { commitment: options.masumi.commitment } : {}),
        },
      })
    : new ExactCardanoScheme();
  return new x402ResourceServer(facilitator).register(NETWORK, scheme);
}

/**
 * The Masumi seller from its mnemonic, refused unless it derives the expected address: the
 * seller named in the escrow terms must be the worker that address belongs to.
 */
export function masumiSeller(mnemonic: string, expectedAddress: string): MasumiSellerSigner {
  // Checked first: the wallet library would put an unknown word in its error message.
  assertMnemonic("SELLER_A_MNEMONIC", mnemonic);
  let seller: MasumiSellerSigner;
  try {
    seller = toMasumiSellerSigner({ mnemonic, network: NETWORK });
  } catch {
    throw new Error("could not derive the Masumi seller from SELLER_A_MNEMONIC");
  }
  if (seller.sellerAddress !== expectedAddress) {
    throw new Error(
      `the Masumi seller key derives ${seller.sellerAddress}, not ${expectedAddress}`,
    );
  }
  return seller;
}

export interface ExactRouteOptions {
  payTo: string | DynamicPayTo;
  price: { amount: string; asset: string } | DynamicPrice;
  description: string;
  mimeType?: string;
  l1Confirmations?: number;
}

/** A `default` (address-to-address) tUSDM route: price and payTo may be computed per request. */
export function exactCardanoRoute(options: ExactRouteOptions): RouteConfig {
  return {
    accepts: {
      scheme: "exact",
      network: NETWORK,
      payTo: options.payTo,
      price: options.price,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: {
        assetTransferMethod: "default",
        areFeesSponsored: false,
        confirmationPolicy: { l1Confirmations: options.l1Confirmations ?? 0 },
      },
    },
    description: options.description,
    mimeType: options.mimeType ?? "application/json",
  };
}

export interface MasumiRouteOptions {
  price: { amount: string; asset: string } | DynamicPrice;
  description: string;
  mimeType?: string;
  l1Confirmations?: number;
}

/**
 * A Masumi escrow route template (PLAN 4.8): payTo is the escrow address and `extra` carries
 * only template keys. The scheme signs a fresh seller quote for every unpaid 402.
 */
export function masumiRoute(options: MasumiRouteOptions): RouteConfig {
  return {
    accepts: {
      scheme: "exact",
      network: NETWORK,
      payTo: masumiEscrowAddress(NETWORK),
      price: options.price,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: {
        assetTransferMethod: "masumi",
        confirmationPolicy: { l1Confirmations: options.l1Confirmations ?? 0 },
      },
    },
    description: options.description,
    mimeType: options.mimeType ?? "application/json",
  };
}

/**
 * The library checks a template only when a request arrives (a bad one turns every call into
 * a 500), so the market calls this at startup and refuses to boot instead.
 */
export function assertMasumiRoute(route: RouteConfig, sample: { amount: string; asset: string }) {
  const accepts = Array.isArray(route.accepts) ? route.accepts : [route.accepts];
  if (accepts.length !== 1) throw new Error("a Masumi route offers exactly one payment option");
  const [option] = accepts as [(typeof accepts)[number]];
  if (typeof option.payTo !== "string") throw new Error("a Masumi route needs a static payTo");
  assertMasumiTemplate(
    {
      scheme: option.scheme,
      network: option.network,
      asset: sample.asset,
      amount: sample.amount,
      payTo: option.payTo,
      maxTimeoutSeconds: option.maxTimeoutSeconds ?? MAX_TIMEOUT_SECONDS,
      extra: option.extra ?? {},
    },
    {},
  );
}

/**
 * The x402 gate for one route. Mount it in that route's own chain on `app`, never in a
 * sub-router: it matches its key against req.path, which is router-relative there (fact 11).
 */
export function paidRoute(pattern: string, route: RouteConfig, server: x402ResourceServer) {
  return paymentMiddleware({ [pattern]: route }, server);
}

export interface PaymentHookInfo {
  txHash: string;
  key: string;
  request?: HTTPRequestContext;
  requirements: PaymentRequirements;
}

export interface PaymentHookHandlers {
  /** The single resource a payment buys, from the request path; null refuses the payment. */
  keyOf(request: HTTPRequestContext | undefined, txHash: string): string | null;
  onSettling?(info: PaymentHookInfo): void | Promise<void>;
  onSettled?(
    info: PaymentHookInfo & { settle: SettleResponse; receipt: PaymentReceipt },
  ): void | Promise<void>;
  onSettleFailed?(info: PaymentHookInfo & { reason: string }): void | Promise<void>;
  /** Only for the payment that holds its resource, and only when the handler failed or threw. */
  onCanceled?(
    info: PaymentHookInfo & { reason: VerifiedPaymentCancellationReason; status?: number },
  ): void | Promise<void>;
  warn?(message: string, detail: Record<string, unknown>): void;
}

function requestOf(transportContext: unknown): HTTPRequestContext | undefined {
  return (transportContext as HTTPTransportContext | undefined)?.request;
}

function clone<T>(value: unknown): T {
  return structuredClone(value) as T;
}

/**
 * Wires PLAN 4.3. Core swallows exceptions thrown by hooks (it only logs them), so every
 * refusal here is an explicit `abort`, and callbacks are guarded.
 */
export function attachPaymentHooks(
  server: x402ResourceServer,
  operations: PaymentOperations,
  handlers: PaymentHookHandlers,
): void {
  const safely = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      handlers.warn?.(`payment hook callback failed: ${name}`, { err });
    }
  };
  const txOf = (payload: unknown): string | null => {
    try {
      return txHashFromPayload(payload as PaymentPayload);
    } catch {
      return null;
    }
  };

  // Resume: a known txHash with an identical payload skips the facilitator's verify, so the
  // request reaches settle, which resumes watching instead of broadcasting again.
  server.onBeforeVerify(async (ctx) => {
    const txHash = txOf(ctx.paymentPayload);
    if (!txHash) return;
    const cached = operations.cachedVerification(txHash, payloadFingerprint(ctx.paymentPayload));
    if (cached) return { skip: true, result: cached };
  });

  server.onAfterVerify(async (ctx) => {
    if (!ctx.result.isValid) return;
    const txHash = txOf(ctx.paymentPayload);
    if (!txHash) return { abort: true, reason: "invalid_payload" };
    const key = handlers.keyOf(requestOf(ctx.transportContext), txHash);
    if (!key) return { abort: true, reason: "unknown_resource" };
    const claim = operations.claim(txHash, key, payloadFingerprint(ctx.paymentPayload));
    if (!claim.ok) return { abort: true, reason: claim.reason };
    operations.recordVerification(txHash, clone(ctx.result));
  });

  server.onBeforeSettle(async (ctx) => {
    const txHash = txOf(ctx.paymentPayload);
    const record = txHash ? operations.get(txHash) : undefined;
    if (!txHash || !record) return;
    const stored = operations.settled(txHash);
    if (stored) return { skip: true, result: clone<SettleResponse>(stored) };
    if (operations.firstTime(txHash, "settling")) {
      const info = { txHash, key: record.key, request: requestOf(ctx.transportContext) };
      await safely("onSettling", () =>
        handlers.onSettling?.({ ...info, requirements: clone(ctx.requirements) }),
      );
    }
  });

  server.onAfterSettle(async (ctx) => {
    const txHash = txOf(ctx.paymentPayload);
    const record = txHash ? operations.get(txHash) : undefined;
    if (!txHash || !record) return;
    const settle = clone<SettleResponse>(ctx.result);
    operations.recordSettle(txHash, settle);
    if (!operations.firstTime(txHash, "settled")) return;
    await safely("onSettled", () => {
      const requirements = clone<PaymentRequirements>(ctx.requirements);
      const receipt = buildReceipt({ paymentPayload: ctx.paymentPayload, requirements, settle });
      return handlers.onSettled?.({
        txHash,
        key: record.key,
        request: requestOf(ctx.transportContext),
        requirements,
        settle,
        receipt,
      });
    });
  });

  server.onSettleFailure(async (ctx) => {
    const txHash = txOf(ctx.paymentPayload);
    const record = txHash ? operations.get(txHash) : undefined;
    if (!txHash || !record || !operations.firstTime(txHash, "settle_failed")) return;
    await safely("onSettleFailed", () =>
      handlers.onSettleFailed?.({
        txHash,
        key: record.key,
        request: requestOf(ctx.transportContext),
        requirements: clone(ctx.requirements),
        reason: ctx.error.message,
      }),
    );
  });

  server.onVerifiedPaymentCanceled(async (ctx) => {
    const txHash = txOf(ctx.paymentPayload);
    const record = txHash ? operations.get(txHash) : undefined;
    if (!txHash || !record) return;
    if (ctx.reason === "after_verify_aborted") {
      // A racing payment for a claimed resource never got a record. If this payment did hold
      // its resource, a later verify hook refused it: free the resource again.
      operations.release(txHash);
      return;
    }
    if (operations.holder(record.key) !== txHash) return;
    operations.markCanceled(txHash, ctx.reason);
    if (!operations.firstTime(txHash, "canceled")) return;
    await safely("onCanceled", () =>
      handlers.onCanceled?.({
        txHash,
        key: record.key,
        request: requestOf(ctx.transportContext),
        requirements: clone(ctx.requirements),
        reason: ctx.reason,
        ...(ctx.responseStatus !== undefined ? { status: ctx.responseStatus } : {}),
      }),
    );
  });
}
