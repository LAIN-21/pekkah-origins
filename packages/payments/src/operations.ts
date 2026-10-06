import { MAX_TIMEOUT_SECONDS } from "@pekkah/protocol";
import type { SettleResponse, VerifyResponse } from "@x402/core/types";

// PaymentOperations (PLAN 4.4): txHash → what that payment bought and how far it got.
// The txHash is the idempotency key: a resumed or replayed request with the same payment
// header finds its record instead of verifying, dispatching or broadcasting again.

export interface PaymentRecord<T = unknown> {
  txHash: string;
  /** The single resource this payment buys: an offerId, or a smoke-route key. */
  key: string;
  fingerprint: string;
  verification?: VerifyResponse;
  settle?: SettleResponse;
  /** Whatever the route keeps per payment (the job, the response body). */
  data?: T;
  canceled?: string;
  /** Event names already emitted for this txHash, so each one goes out once. */
  emitted: Set<string>;
  createdAt: number;
}

export type ClaimResult<T> =
  | { ok: true; record: PaymentRecord<T>; resumed: boolean }
  | {
      ok: false;
      reason:
        | "offer_already_purchased"
        | "payment_bound_elsewhere"
        | "payload_mismatch"
        | "payment_expired";
      holder?: string;
    };

export interface PaymentOperationsOptions {
  now?: () => number;
  /**
   * An unsettled claim older than this can never settle: its signed transaction's validity
   * window (maxTimeoutSeconds) has closed. It no longer holds its resource.
   */
  leaseMs?: number;
  /** How long settled payments are kept, so a replayed request gets the same answer. */
  retainMs?: number;
}

export class PaymentOperations<T = unknown> {
  private readonly byTx = new Map<string, PaymentRecord<T>>();
  private readonly byKey = new Map<string, string>();
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly retainMs: number;
  private lastSweep = 0;

  constructor(options: PaymentOperationsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? MAX_TIMEOUT_SECONDS * 1000;
    this.retainMs = options.retainMs ?? 6 * 60 * 60 * 1000;
  }

  private expired(record: PaymentRecord<T>): boolean {
    return !record.settle && this.now() - record.createdAt >= this.leaseMs;
  }

  private evict(record: PaymentRecord<T>): void {
    this.byTx.delete(record.txHash);
    if (this.byKey.get(record.key) === record.txHash) this.byKey.delete(record.key);
  }

  /** Drops claims past their lease and settled payments past retention. */
  sweep(): void {
    const now = this.now();
    this.lastSweep = now;
    for (const record of this.byTx.values()) {
      if (this.expired(record) || (record.settle && now - record.createdAt >= this.retainMs)) {
        this.evict(record);
      }
    }
  }

  size(): number {
    return this.byTx.size;
  }

  get(txHash: string): PaymentRecord<T> | undefined {
    return this.byTx.get(txHash);
  }

  /** The txHash that holds a key, if any. */
  holder(key: string): string | undefined {
    return this.byKey.get(key);
  }

  /** The txHash that still holds a key: a claim past its lease holds nothing. */
  activeHolder(key: string): string | undefined {
    const txHash = this.byKey.get(key);
    const record = txHash ? this.byTx.get(txHash) : undefined;
    return record && !this.expired(record) ? txHash : undefined;
  }

  /**
   * Binds a txHash to the resource it pays for. Idempotent for the same txHash, key and
   * payload; a different transaction for a claimed key is refused.
   */
  claim(txHash: string, key: string, fingerprint: string): ClaimResult<T> {
    const existing = this.byTx.get(txHash);
    if (existing && this.expired(existing)) {
      this.evict(existing);
      return { ok: false, reason: "payment_expired" };
    }
    if (this.now() - this.lastSweep >= 60_000) this.sweep();
    if (existing) {
      if (existing.key !== key) {
        return { ok: false, reason: "payment_bound_elsewhere", holder: existing.key };
      }
      if (existing.fingerprint !== fingerprint) return { ok: false, reason: "payload_mismatch" };
      return { ok: true, record: existing, resumed: true };
    }
    const holder = this.byKey.get(key);
    if (holder && holder !== txHash) {
      const held = this.byTx.get(holder);
      if (held && !this.expired(held)) {
        return { ok: false, reason: "offer_already_purchased", holder };
      }
      if (held) this.evict(held);
    }
    const record: PaymentRecord<T> = {
      txHash,
      key,
      fingerprint,
      emitted: new Set(),
      createdAt: this.now(),
    };
    this.byTx.set(txHash, record);
    this.byKey.set(key, txHash);
    return { ok: true, record, resumed: false };
  }

  /** A cached verification, only for the identical payload. */
  cachedVerification(txHash: string, fingerprint: string): VerifyResponse | undefined {
    const record = this.byTx.get(txHash);
    if (!record || record.fingerprint !== fingerprint) return undefined;
    return record.verification?.isValid ? record.verification : undefined;
  }

  recordVerification(txHash: string, verification: VerifyResponse): void {
    const record = this.byTx.get(txHash);
    if (record && verification.isValid) record.verification = verification;
  }

  /** True when every verify hook passed for this txHash: the handler's own precondition. */
  isVerified(txHash: string): boolean {
    return this.byTx.get(txHash)?.verification?.isValid === true;
  }

  recordSettle(txHash: string, settle: SettleResponse): void {
    const record = this.byTx.get(txHash);
    if (record && settle.success) record.settle = settle;
  }

  /** The stored settle response of a payment that already settled (a replayed request). */
  settled(txHash: string): SettleResponse | undefined {
    return this.byTx.get(txHash)?.settle;
  }

  /**
   * Forgets a claim that a later verify hook refused. A payment that reached its handler or
   * settled is never released.
   */
  release(txHash: string): boolean {
    const record = this.byTx.get(txHash);
    if (!record || record.settle || record.data !== undefined || record.canceled) return false;
    this.byTx.delete(txHash);
    if (this.byKey.get(record.key) === txHash) this.byKey.delete(record.key);
    return true;
  }

  markCanceled(txHash: string, reason: string): void {
    const record = this.byTx.get(txHash);
    if (record && !record.settle) record.canceled = reason;
  }

  setData(txHash: string, data: T): void {
    const record = this.byTx.get(txHash);
    if (record) record.data = data;
  }

  /** True the first time a named event is emitted for a txHash. */
  firstTime(txHash: string, name: string): boolean {
    const record = this.byTx.get(txHash);
    if (!record) return false;
    if (record.emitted.has(name)) return false;
    record.emitted.add(name);
    return true;
  }
}
