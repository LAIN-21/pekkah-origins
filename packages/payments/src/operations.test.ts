import { describe, expect, it } from "vitest";
import { PaymentOperations } from "./operations.js";

const TX1 = "1".repeat(64);
const TX2 = "2".repeat(64);
const valid = { isValid: true, payer: "addr_test1buyer" };

describe("PaymentOperations", () => {
  it("binds a txHash to one resource and is idempotent for the same payment", () => {
    const ops = new PaymentOperations();
    const first = ops.claim(TX1, "offer-1", "fp1");
    expect(first).toMatchObject({ ok: true, resumed: false });
    const again = ops.claim(TX1, "offer-1", "fp1");
    expect(again).toMatchObject({ ok: true, resumed: true });
    expect(ops.holder("offer-1")).toBe(TX1);
  });

  it("refuses a different transaction for a claimed resource", () => {
    const ops = new PaymentOperations();
    ops.claim(TX1, "offer-1", "fp1");
    expect(ops.claim(TX2, "offer-1", "fp2")).toEqual({
      ok: false,
      reason: "offer_already_purchased",
      holder: TX1,
    });
    expect(ops.get(TX2)).toBeUndefined();
  });

  it("refuses one payment for two resources, and a changed payload", () => {
    const ops = new PaymentOperations();
    ops.claim(TX1, "offer-1", "fp1");
    expect(ops.claim(TX1, "offer-2", "fp1")).toMatchObject({
      ok: false,
      reason: "payment_bound_elsewhere",
    });
    expect(ops.claim(TX1, "offer-1", "other")).toMatchObject({
      ok: false,
      reason: "payload_mismatch",
    });
  });

  it("caches a verification only for the identical payload", () => {
    const ops = new PaymentOperations();
    ops.claim(TX1, "offer-1", "fp1");
    expect(ops.isVerified(TX1)).toBe(false);
    ops.recordVerification(TX1, valid);
    expect(ops.isVerified(TX1)).toBe(true);
    expect(ops.cachedVerification(TX1, "fp1")).toEqual(valid);
    expect(ops.cachedVerification(TX1, "fp2")).toBeUndefined();
    ops.recordVerification(TX2, valid);
    expect(ops.isVerified(TX2)).toBe(false);
  });

  it("stores a settlement once and replays it", () => {
    const ops = new PaymentOperations();
    ops.claim(TX1, "offer-1", "fp1");
    ops.recordSettle(TX1, { success: false, transaction: "", network: "cardano:preprod" });
    expect(ops.settled(TX1)).toBeUndefined();
    const settle = { success: true, transaction: TX1, network: "cardano:preprod" as const };
    ops.recordSettle(TX1, settle);
    expect(ops.settled(TX1)).toEqual(settle);
  });

  it("emits each named event once per txHash", () => {
    const ops = new PaymentOperations();
    expect(ops.firstTime(TX1, "settled")).toBe(false);
    ops.claim(TX1, "offer-1", "fp1");
    expect(ops.firstTime(TX1, "settled")).toBe(true);
    expect(ops.firstTime(TX1, "settled")).toBe(false);
    expect(ops.firstTime(TX1, "canceled")).toBe(true);
  });

  it("releases a refused claim, but never one that reached its handler or settled", () => {
    const ops = new PaymentOperations<{ jobId: string }>();
    ops.claim(TX1, "offer-1", "fp1");
    expect(ops.release(TX1)).toBe(true);
    expect(ops.holder("offer-1")).toBeUndefined();
    expect(ops.claim(TX2, "offer-1", "fp2").ok).toBe(true);
    ops.setData(TX2, { jobId: "j" });
    expect(ops.release(TX2)).toBe(false);
    expect(ops.holder("offer-1")).toBe(TX2);
  });

  it("marks a cancellation only before settlement", () => {
    const ops = new PaymentOperations();
    ops.claim(TX1, "offer-1", "fp1");
    ops.markCanceled(TX1, "handler_failed");
    expect(ops.get(TX1)?.canceled).toBe("handler_failed");
    ops.claim(TX2, "offer-2", "fp2");
    ops.recordSettle(TX2, { success: true, transaction: TX2, network: "cardano:preprod" });
    ops.markCanceled(TX2, "handler_failed");
    expect(ops.get(TX2)?.canceled).toBeUndefined();
  });

  it("frees a resource whose unsettled claim outlived the 600 s validity window", () => {
    let now = 0;
    const ops = new PaymentOperations({ now: () => now });
    ops.claim(TX1, "offer-1", "fp1");
    now = 599_000;
    expect(ops.claim(TX2, "offer-1", "fp2")).toMatchObject({ reason: "offer_already_purchased" });
    now = 600_000;
    expect(ops.claim(TX2, "offer-1", "fp2")).toMatchObject({ ok: true, resumed: false });
    expect(ops.holder("offer-1")).toBe(TX2);
    expect(ops.get(TX1)).toBeUndefined();
  });

  it("refuses to resume an expired unsettled payment, and frees its resource", () => {
    let now = 0;
    const ops = new PaymentOperations({ now: () => now });
    ops.claim(TX1, "offer-1", "fp1");
    now = 601_000;
    expect(ops.claim(TX1, "offer-1", "fp1")).toEqual({ ok: false, reason: "payment_expired" });
    expect(ops.holder("offer-1")).toBeUndefined();
  });

  it("keeps settled payments for replays until retention ends, then sweeps everything stale", () => {
    let now = 0;
    const ops = new PaymentOperations({ now: () => now, retainMs: 3_600_000 });
    ops.claim(TX1, "offer-1", "fp1");
    ops.recordSettle(TX1, { success: true, transaction: TX1, network: "cardano:preprod" });
    for (let i = 0; i < 50; i++) ops.claim(`${i}`.padStart(64, "f"), `offer-x${i}`, "fp");
    expect(ops.size()).toBe(51);
    now = 700_000;
    ops.sweep();
    expect(ops.size()).toBe(1);
    expect(ops.claim(TX1, "offer-1", "fp1")).toMatchObject({ ok: true, resumed: true });
    now = 3_700_000;
    ops.sweep();
    expect(ops.size()).toBe(0);
  });
});
