import { DEFAULT_ASSET } from "@pekkah/protocol";
import { masumiEscrowAddress } from "@x402/cardano";
import { describe, expect, it } from "vitest";
import { check402, type PaymentExpectation, type RequirementsLike } from "./check.js";
import { SpendLedger } from "./ledger.js";
import { PaymentMutex } from "./mutex.js";

const SELLER_B = `addr_test1${"q".repeat(53)}`;
const SELLER_C = `addr_test1${"z".repeat(53)}`;

const expectB: PaymentExpectation = {
  payTo: SELLER_B,
  amountAtomic: "10000",
  asset: DEFAULT_ASSET,
};
const req: RequirementsLike = {
  scheme: "exact",
  network: "cardano:preprod",
  asset: DEFAULT_ASSET,
  amount: "10000",
  payTo: SELLER_B,
  maxTimeoutSeconds: 600,
  extra: { areFeesSponsored: false, confirmationPolicy: { l1Confirmations: 0 } },
};

describe("check402 (default payments)", () => {
  it("accepts exactly what was agreed, with a missing assetTransferMethod meaning default", () => {
    expect(check402(req, expectB)).toBeNull();
    expect(check402({ ...req, extra: { assetTransferMethod: "default" } }, expectB)).toBeNull();
    expect(check402({ ...req, extra: undefined }, expectB)).toBeNull();
  });

  it("refuses another payee, amount, asset or network", () => {
    expect(check402({ ...req, payTo: SELLER_C }, expectB)).toMatch(/payTo/);
    expect(check402({ ...req, amount: "10001" }, expectB)).toMatch(/amount/);
    expect(check402({ ...req, asset: "lovelace" }, expectB)).toMatch(/asset/);
    expect(check402({ ...req, network: "cardano:mainnet" }, expectB)).toMatch(/network/);
    expect(check402({ ...req, scheme: "upto" }, expectB)).toMatch(/scheme/);
  });

  it("refuses long validity windows, other flows and other transfer methods", () => {
    expect(check402({ ...req, maxTimeoutSeconds: 601 }, expectB)).toMatch(/maxTimeoutSeconds/);
    expect(check402({ ...req, extra: { paymentFlow: "escrow" } }, expectB)).toMatch(/flow/);
    expect(check402({ ...req, extra: { assetTransferMethod: "script" } }, expectB)).toMatch(
      /transfer method/,
    );
    expect(check402({ ...req, extra: { assetTransferMethod: "masumi" } }, expectB)).toMatch(
      /transfer method/,
    );
  });
});

describe("check402 (Masumi escrow)", () => {
  const ESCROW = masumiEscrowAddress("cardano:preprod");
  const request = { workload: "fractal", params: { preset: "hd-fast", palette: "mint" } };
  const masumiReq = (sellerAddress: string, parameters?: unknown): RequirementsLike => ({
    ...req,
    payTo: ESCROW,
    extra: {
      assetTransferMethod: "masumi",
      terms: { sellerAddress, inputHash: "ab".repeat(32) },
      inputCommitment: {
        parts:
          parameters === undefined
            ? [{ name: "resource", content: { url: "http://x/api/dev/smoke-escrow" } }]
            : [{ name: "parameters", canonicalization: "jcs", content: parameters }],
      },
    },
  });
  const expectLock: PaymentExpectation = {
    payTo: ESCROW,
    amountAtomic: "10000",
    asset: DEFAULT_ASSET,
    transferMethod: "masumi",
    seller: SELLER_B,
  };

  it("accepts a lock at the escrow with the expected worker as seller", () => {
    expect(check402(masumiReq(SELLER_B), expectLock)).toBeNull();
  });

  it("refuses a Masumi 402 whose seller differs from the expected address", () => {
    expect(check402(masumiReq(SELLER_C), expectLock)).toMatch(/seller/);
    expect(check402(masumiReq(SELLER_B), { ...expectLock, seller: undefined })).toMatch(/seller/);
  });

  it("refuses a Masumi payTo that is not the escrow", () => {
    expect(check402({ ...masumiReq(SELLER_B), payTo: SELLER_C }, expectLock)).toMatch(/escrow/);
    expect(check402(masumiReq(SELLER_B), { ...expectLock, payTo: SELLER_C })).toMatch(/escrow/);
  });

  it("binds an offer's lock to the exact request quoted, in any key order", () => {
    const reordered = { params: { palette: "mint", preset: "hd-fast" }, workload: "fractal" };
    expect(
      check402(masumiReq(SELLER_B, reordered), { ...expectLock, parameters: request }),
    ).toBeNull();
    const other = { ...request, params: { preset: "hd-heavy", palette: "mint" } };
    expect(check402(masumiReq(SELLER_B, other), { ...expectLock, parameters: request })).toMatch(
      /different request/,
    );
    expect(check402(masumiReq(SELLER_B), { ...expectLock, parameters: request })).toMatch(
      /does not commit/,
    );
  });

  it("refuses a Masumi 402 when a default payment was accepted, and the reverse", () => {
    expect(check402(masumiReq(SELLER_B), expectB)).toMatch(/transfer method/);
    expect(check402(req, expectLock)).toMatch(/transfer method/);
  });
});

describe("SpendLedger", () => {
  const caps = { perPayment: 100_000n, perRun: 200_000n, perDay: 5_000_000n };

  it("enforces the per-payment, per-run and per-day caps", () => {
    let now = new Date("2026-10-06T10:00:00Z");
    const ledger = new SpendLedger(caps, () => now);
    expect(ledger.check("r1", "100001")).toMatch(/per-payment/);
    ledger.record("r1", "100000");
    ledger.record("r1", "50000");
    expect(ledger.check("r1", "50000")).toBeNull();
    expect(ledger.check("r1", "50001")).toMatch(/per-run/);
    expect(ledger.check("r2", "100000")).toBeNull();
    for (let i = 0; i < 32; i++) ledger.record(`day-${i}`, "150000");
    expect(ledger.check("r3", "50000")).toBeNull(); // exactly $5.00 is allowed
    expect(ledger.check("r3", "50001")).toMatch(/per-day/);
    now = new Date("2026-10-07T00:00:01Z");
    expect(ledger.check("r3", "50001")).toBeNull();
  });
});

describe("PaymentMutex", () => {
  it("runs one payment at a time and keeps the lock through a hold", async () => {
    const mutex = new PaymentMutex();
    const order: string[] = [];
    let confirm!: () => void;
    const onChain = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const first = mutex.run(async (hold) => {
      order.push("pay 1");
      hold(onChain.then(() => order.push("tx 1 on chain")));
      return 1;
    });
    const second = mutex.run(async () => {
      order.push("pay 2");
      return 2;
    });
    expect(await first).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["pay 1"]);
    confirm();
    expect(await second).toBe(2);
    await mutex.idle();
    expect(order).toEqual(["pay 1", "tx 1 on chain", "pay 2"]);
  });

  it("releases the lock when a payment throws", async () => {
    const mutex = new PaymentMutex();
    await expect(mutex.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await mutex.run(async () => "next")).toBe("next");
  });
});
