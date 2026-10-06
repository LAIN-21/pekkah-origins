import { ASSET_DECIMALS, LOVELACE_DECIMALS } from "./constants.js";

// Money is integer atomic units internally. USD numbers exist only for display and for
// request budgets, and are converted once, here.

const DIGITS = /^(0|[1-9]\d*)$/;

function toBigInt(atomic: string | bigint): bigint {
  if (typeof atomic === "bigint") {
    if (atomic < 0n) throw new RangeError("atomic amount must not be negative");
    return atomic;
  }
  if (!DIGITS.test(atomic)) throw new RangeError("atomic amount must be a string of digits");
  return BigInt(atomic);
}

/** 0.05 → "50000". Rounds to the nearest atomic unit. */
export function usdToAtomic(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new RangeError("usd must be a finite, non-negative number");
  }
  const scaled = Math.round(usd * 10 ** ASSET_DECIMALS);
  if (!Number.isSafeInteger(scaled)) throw new RangeError("usd amount too large");
  return String(scaled);
}

/** "50000" → 0.05. For display and comparisons with request budgets only. */
export function atomicToUsd(atomic: string | bigint): number {
  return Number(toBigInt(atomic)) / 10 ** ASSET_DECIMALS;
}

/** Exact decimal string: ("15000", 6) → "0.015", ("100000", 6) → "0.10". */
export function formatAtomic(
  atomic: string | bigint,
  decimals: number = ASSET_DECIMALS,
  minFractionDigits = 2,
): string {
  const digits = toBigInt(atomic)
    .toString()
    .padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  if (fraction.length < minFractionDigits) fraction = fraction.padEnd(minFractionDigits, "0");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** "15000" → "$0.015". */
export function formatUsdAtomic(atomic: string | bigint): string {
  return `$${formatAtomic(atomic)}`;
}

/** 0.05 → "$0.05". */
export function formatUsd(usd: number): string {
  return formatUsdAtomic(usdToAtomic(usd));
}

/** 1_200_000n → "1.2 tADA". */
export function formatLovelace(lovelace: string | bigint): string {
  return `${formatAtomic(lovelace, LOVELACE_DECIMALS, 1)} tADA`;
}

export function compareAtomic(a: string | bigint, b: string | bigint): -1 | 0 | 1 {
  const x = toBigInt(a);
  const y = toBigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
