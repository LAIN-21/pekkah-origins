import { z } from "zod";

/** Opaque ids (ulid in practice). */
export const Id = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, "invalid id");

/** Worker ids are short names such as A, B, C (they key WORKER_TOKENS). */
export const WorkerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, "invalid worker id");
export type WorkerId = z.infer<typeof WorkerId>;

export const IsoDate = z.string().datetime({ offset: true });

export const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex characters");
export const TxHash = Hex64;
export const Sha256 = Hex64;

/** Preprod only: mainnet addresses are refused. */
export const CardanoAddress = z
  .string()
  .regex(/^addr_test1[02-9ac-hj-np-z]{40,200}$/, "expected a preprod address (addr_test1…)");

/** `<policyId hex>.<assetName hex>` or `lovelace`. */
export const AssetId = z
  .string()
  .regex(
    /^(lovelace|[0-9a-f]{56}\.[0-9a-f]{0,64})$/,
    "expected lovelace or <policyId>.<assetNameHex>",
  );

/** Integer atomic units as a string of digits (6 decimals for tUSDM and for lovelace → ADA). */
export const AtomicAmount = z.string().regex(/^(0|[1-9]\d*)$/, "expected a string of digits");

/** POSIX milliseconds as a canonical base-10 string, as in Masumi's signed terms. */
export const PosixMs = z.string().regex(/^[1-9]\d*$/, "expected POSIX milliseconds");
