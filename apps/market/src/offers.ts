import type { MatchResult } from "@pekkah/matcher";
import {
  type ComputeRequest,
  type CounterOffer,
  MAX_TIMEOUT_SECONDS,
  OFFER_TTL_SEC,
  type Offer,
  type Quote,
} from "@pekkah/protocol";

export type OfferState = "open" | "required" | "claimed" | "closed";

export interface OfferRecord {
  offer: Offer;
  request: ComputeRequest;
  runId?: string;
  state: OfferState;
  /** When the 402 was first served: from then on the offer is payable for maxTimeoutSeconds. */
  requiredAt?: number;
}

/**
 * Offers are single use and expire 120 s after the quote; once its 402 has been served, an
 * offer stays payable for the payment's validity window (PLAN 4.4). In memory: a restart
 * drops open offers and agents re-quote.
 */
export class OfferStore {
  private readonly offers = new Map<string, OfferRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  add(records: OfferRecord[]): void {
    this.sweep();
    for (const record of records) this.offers.set(record.offer.offerId, record);
  }

  get(offerId: string): OfferRecord | undefined {
    return this.offers.get(offerId);
  }

  payableUntil(record: OfferRecord): number {
    return record.requiredAt !== undefined
      ? record.requiredAt + MAX_TIMEOUT_SECONDS * 1000
      : Date.parse(record.offer.expiresAt);
  }

  /** Open, or its 402 served, and within its window. */
  isPayable(record: OfferRecord): boolean {
    return (
      (record.state === "open" || record.state === "required") &&
      this.now() < this.payableUntil(record)
    );
  }

  markRequired(offerId: string): void {
    const record = this.offers.get(offerId);
    if (record?.state === "open") {
      record.state = "required";
      record.requiredAt = this.now();
    }
  }

  setState(offerId: string, state: OfferState): void {
    const record = this.offers.get(offerId);
    if (record) record.state = state;
  }

  /** Forgets offers nobody can pay any more (claimed ones stay with their payment). */
  sweep(): void {
    const now = this.now();
    for (const [id, record] of this.offers) {
      if (record.state !== "claimed" && now >= this.payableUntil(record) + 60_000)
        this.offers.delete(id);
    }
  }

  size(): number {
    return this.offers.size;
  }
}

export interface QuoteContext {
  quoteId: string;
  runId?: string;
  asset: string;
  now: number;
  nextId: () => string;
}

/** Turns a match into a Quote with single-use offers, and the records the store keeps. */
export function buildQuote(
  request: ComputeRequest,
  result: MatchResult,
  ctx: QuoteContext,
): { quote: Quote; records: OfferRecord[] } {
  const expiresAt = new Date(ctx.now + OFFER_TTL_SEC * 1000).toISOString();
  const records: OfferRecord[] = [];
  const toOffer = (c: MatchResult["offers"][number], kind: Offer["kind"]): Offer => {
    const offer: Offer = {
      offerId: ctx.nextId(),
      quoteId: ctx.quoteId,
      workerId: c.workerId,
      workload: request.workload,
      priceUsd: c.priceUsd,
      priceAtomic: c.priceAtomic,
      asset: ctx.asset,
      payTo: c.payTo,
      estSec: c.estSec,
      expiresAt,
      kind,
    };
    records.push({ offer, request, ...(ctx.runId ? { runId: ctx.runId } : {}), state: "open" });
    return offer;
  };
  const offers = result.offers.map((c) => toOffer(c, "exact"));
  const counterOffer: CounterOffer | undefined = result.counterOffer
    ? { ...toOffer(result.counterOffer, "counter"), reason: result.counterOffer.reason }
    : undefined;
  return {
    quote: {
      quoteId: ctx.quoteId,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      request,
      offers,
      ...(counterOffer ? { counterOffer } : {}),
      marketPriceUsd: result.marketPriceUsd,
      rejected: result.rejected,
      expiresAt,
    },
    records,
  };
}
