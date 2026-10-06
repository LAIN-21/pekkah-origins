import { formatAtomic, formatLovelace, MASUMI_LOCK_LABEL } from "@pekkah/protocol";
import { decodeCardanoTransaction } from "@x402/cardano";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";

/** What my agent locked in Masumi escrow (PLAN 4.9 point 6). Nothing here was paid out. */
export interface EscrowReceipt {
  escrowAddress: string;
  sellerAddress: string;
  /** The commitment to the exact request my agent quoted. */
  inputHash: string;
  amountAtomic: string;
  asset: string;
  collateralLovelace: string;
  inlineDatum: boolean;
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
}

/** From the seller-signed terms my agent accepted and the lock output of the tx it signed. */
export function escrowReceipt(accepted: PaymentRequirements, paymentHeader: string): EscrowReceipt {
  const terms = (accepted.extra?.terms ?? {}) as Record<string, unknown>;
  const tx = decodeCardanoTransaction(
    String(decodePaymentSignatureHeader(paymentHeader).payload.transaction),
  );
  const lock = tx.outputs.find(
    (o) => o.address === accepted.payTo && (o.assets[accepted.asset] ?? 0n) > 0n,
  );
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    escrowAddress: accepted.payTo,
    sellerAddress: text(terms.sellerAddress),
    inputHash: text(terms.inputHash),
    amountAtomic: (lock?.assets[accepted.asset] ?? 0n).toString(),
    asset: accepted.asset,
    collateralLovelace: (lock?.coin ?? 0n).toString(),
    inlineDatum: Boolean(lock?.datum),
    payByTime: text(terms.payByTime),
    submitResultTime: text(terms.submitResultTime),
    unlockTime: text(terms.unlockTime),
    externalDisputeUnlockTime: text(terms.externalDisputeUnlockTime),
  };
}

/** ISO date and time in Singapore, e.g. 2026-10-06 16:43:24 SGT. */
const sgt = (posixMs: string) =>
  `${new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Singapore",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(Number(posixMs)))} SGT`;

/** The receipt lines for an escrow run: "locked in escrow", never paid or released. */
export function escrowLines(r: EscrowReceipt, workerId: string): string[] {
  return [
    `locked     ${formatAtomic(r.amountAtomic)} tUSDM + ${formatLovelace(r.collateralLovelace)} collateral in Masumi escrow`,
    `escrow     ${r.escrowAddress}`,
    `seller     worker ${workerId} (${r.sellerAddress})`,
    `inputHash  ${r.inputHash} (commits to the request I quoted)`,
    `datum      inline datum ${r.inlineDatum ? "present" : "missing"} on the escrow output`,
    `payBy      ${sgt(r.payByTime)}`,
    `submit     ${sgt(r.submitResultTime)}`,
    `unlock     ${sgt(r.unlockTime)}`,
    `dispute    ${sgt(r.externalDisputeUnlockTime)}`,
    `status     ${MASUMI_LOCK_LABEL}`,
  ];
}
