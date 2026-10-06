import { describe, expect, it } from "vitest";
import {
  atomicToUsd,
  compareAtomic,
  formatAtomic,
  formatLovelace,
  formatUsd,
  formatUsdAtomic,
  usdToAtomic,
} from "./money.js";

describe("usdToAtomic", () => {
  it("converts the plan's prices exactly", () => {
    expect(usdToAtomic(0.05)).toBe("50000");
    expect(usdToAtomic(0.03)).toBe("30000");
    expect(usdToAtomic(0.02)).toBe("20000");
    expect(usdToAtomic(0.015)).toBe("15000");
    expect(usdToAtomic(0.01)).toBe("10000");
    expect(usdToAtomic(0.1)).toBe("100000");
    expect(usdToAtomic(5)).toBe("5000000");
    expect(usdToAtomic(0)).toBe("0");
  });

  it("is exact for every tenth of a cent up to $1", () => {
    for (let tenths = 0; tenths <= 1000; tenths += 1) {
      const usd = tenths / 1000;
      expect(usdToAtomic(usd)).toBe(String(tenths * 1000));
    }
  });

  it("rejects negative and non-finite amounts", () => {
    expect(() => usdToAtomic(-0.01)).toThrow(RangeError);
    expect(() => usdToAtomic(Number.NaN)).toThrow(RangeError);
    expect(() => usdToAtomic(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("atomicToUsd", () => {
  it("round-trips with usdToAtomic", () => {
    for (const usd of [0, 0.01, 0.015, 0.02, 0.03, 0.05, 0.1, 0.2, 5]) {
      expect(atomicToUsd(usdToAtomic(usd))).toBe(usd);
    }
    expect(atomicToUsd(50000n)).toBe(0.05);
  });

  it("refuses anything but digits", () => {
    expect(() => atomicToUsd("-1")).toThrow(RangeError);
    expect(() => atomicToUsd("1.5")).toThrow(RangeError);
    expect(() => atomicToUsd("")).toThrow(RangeError);
    expect(() => atomicToUsd("007")).toThrow(RangeError);
    expect(() => atomicToUsd(-1n)).toThrow(RangeError);
  });
});

describe("formatting", () => {
  it("formats exact decimals with at least two fraction digits", () => {
    expect(formatAtomic("15000")).toBe("0.015");
    expect(formatAtomic("50000")).toBe("0.05");
    expect(formatAtomic("100000")).toBe("0.10");
    expect(formatAtomic("5000000")).toBe("5.00");
    expect(formatAtomic("0")).toBe("0.00");
    expect(formatAtomic("1")).toBe("0.000001");
    expect(formatAtomic(123456789n)).toBe("123.456789");
  });

  it("formats USD and tADA for display", () => {
    expect(formatUsd(0.05)).toBe("$0.05");
    expect(formatUsd(0.015)).toBe("$0.015");
    expect(formatUsdAtomic("20000")).toBe("$0.02");
    expect(formatLovelace("1200000")).toBe("1.2 tADA");
    expect(formatLovelace(1_444_000n)).toBe("1.444 tADA");
    expect(formatLovelace("2000000")).toBe("2.0 tADA");
  });

  it("compares atomic amounts without floats", () => {
    expect(compareAtomic("30000", "50000")).toBe(-1);
    expect(compareAtomic("50000", 50000n)).toBe(0);
    expect(compareAtomic("100000000000000000001", "100000000000000000000")).toBe(1);
  });
});
