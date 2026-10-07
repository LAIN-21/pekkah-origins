import {
  Address,
  Assets,
  Data,
  InlineDatum,
  KeyHash,
  ScriptHash,
  TransactionHash,
  TransactionInput,
  type UTxO,
} from "@evolution-sdk/evolution";
import { largestFirstSelection } from "@evolution-sdk/evolution/sdk/builders/CoinSelection";
import { NETWORK } from "@pekkah/protocol";
import {
  addressCredentials,
  inlineDatum,
  type MasumiAddressCredentials,
  type MasumiCredential,
  masumiEscrowAddress,
  parseMasumiLockDatum,
} from "@x402/cardano";
import { masumiValidator } from "./masumi-validator.js";
import { collateralReserve, type SellerChain, type SellerClient } from "./result-submit.js";

// Masumi's Withdraw (PR-16, vested_pay V2): after unlock_time, Seller A collects the price and
// the buyer's collateral goes back to the buyer, both in one transaction.

/** vested_pay V2 `Action`: Withdraw 0 … */
const WITHDRAW = 0n;
/** vested_pay V2 `State`: FundsLocked 0, ResultSubmitted 1, … */
const RESULT_SUBMITTED = 1n;
/** States a buyer may refund from (WithdrawRefund): FundsLocked 0, RefundRequested 2, RefundAuthorized 5. */
const REFUNDABLE = new Set([0n, 2n, 5n]);
/** How long a release transaction may wait to land. */
const VALID_FOR_MS = 180_000;
/** The validity range starts this long after unlock_time, which covers slot rounding. */
const AFTER_UNLOCK_MS = 1_000n;
/** A lock is followed through at most this many spends (SubmitResult is the only one today). */
const MAX_HOPS = 6;

/** What a release pays, read from the escrow output and its datum. */
export interface ReleasePlan {
  buyerAddress: string;
  sellerAddress: string;
  /** The escrow's token: `policy.name`, as PEKKAH_ASSET. */
  asset: string;
  amountAtomic: string;
  /** All of the escrow's lovelace, back to the buyer: at least the collateral. */
  buyerLovelace: string;
  collateralReturnLovelace: string;
  unlockTime: number;
}

export type BuiltRelease =
  | {
      ok: true;
      plan: ReleasePlan;
      feeLovelace: string;
      exUnits: { mem: string; steps: string }[];
      /** Signs and submits; returns the transaction hash. */
      submit: () => Promise<string>;
    }
  | { ok: false; reason: string; retry: boolean };

function credential(c: MasumiCredential): KeyHash.KeyHash | ScriptHash.ScriptHash {
  return c.isScript ? ScriptHash.fromHex(c.hash) : KeyHash.fromHex(c.hash);
}

/** The datum's address, rebuilt exactly (payment and stake credentials): the validator compares
 * whole addresses. */
export function addressFromCredentials(c: MasumiAddressCredentials): Address.Address {
  if (c.pointer) throw new Error("pointer addresses are not supported");
  return new Address.Address({
    networkId: 0,
    paymentCredential: credential(c.payment),
    ...(c.stake ? { stakingCredential: credential(c.stake) } : {}),
  });
}

function sameCredentials(a: MasumiAddressCredentials, b: MasumiAddressCredentials): boolean {
  return (
    a.payment.isScript === b.payment.isScript &&
    a.payment.hash === b.payment.hash &&
    a.stake?.isScript === b.stake?.isScript &&
    a.stake?.hash === b.stake?.hash &&
    a.pointer === undefined &&
    b.pointer === undefined
  );
}

/** vested_pay counts an output only when its inline datum is the spent UTxO's reference: the
 * Plutus V3 `OutputReference`, `Constr 0 [tx hash bytes, output index]`. */
export function outputReferenceTag(txHash: string, outputIndex: number): Data.Constr {
  return Data.constr(0n, [Data.bytearray(txHash), Data.int(BigInt(outputIndex))]);
}

/** `policy` + `name` hex, as the SDK spells a unit, to `policy.name`. */
const assetId = (unit: string) => `${unit.slice(0, 56)}.${unit.slice(56)}`;

/**
 * Builds and evaluates the Withdraw for one escrow UTxO, without signing it. Refuses unless the
 * escrow is ResultSubmitted, its seller is Seller A and its unlock time has passed. The buyer
 * gets all of the escrow's lovelace (at least the collateral); Seller A gets the token, with
 * its min-ADA and the fee paid from Seller A's other UTxOs, never from the collateral reserve.
 */
export async function buildRelease(
  client: SellerClient,
  utxo: UTxO.UTxO,
  o: { sellerAddress: string; now: () => number },
): Promise<BuiltRelease> {
  const refuse = (reason: string) => ({ ok: false as const, reason, retry: false });
  if (Address.toBech32(utxo.address) !== masumiEscrowAddress(NETWORK)) {
    return refuse("the output is not at the Masumi escrow address");
  }
  if (!(utxo.datumOption instanceof InlineDatum.InlineDatum)) {
    return refuse("the escrow output has no inline datum");
  }
  const view = parseMasumiLockDatum(utxo.datumOption.data);
  if (!view) return refuse("the escrow datum is malformed");
  if (view.state !== RESULT_SUBMITTED) {
    return refuse(`the escrow is in state ${view.state}, not ResultSubmitted`);
  }
  const seller = addressCredentials(o.sellerAddress);
  if (!sameCredentials(view.seller, seller)) return refuse("the escrow's seller is not Seller A");
  if (view.sellerReturnAddress) return refuse("the escrow names a seller return address");
  const escrowLovelace = Assets.lovelaceOf(utxo.assets);
  if (escrowLovelace < view.collateralReturnLovelace) {
    return refuse("the escrow holds less lovelace than the collateral");
  }
  const tokens = Assets.withoutLovelace(utxo.assets);
  const units = Assets.getUnits(tokens).filter((unit) => unit !== "lovelace");
  const [unit] = units;
  if (!unit || units.length !== 1) return refuse("the escrow does not hold exactly one token");
  const from = view.unlockTime + AFTER_UNLOCK_MS;
  if (BigInt(o.now()) < from) {
    return { ok: false, reason: "the escrow is not unlocked yet", retry: true };
  }
  const buyer = addressFromCredentials(view.buyerReturnAddress ?? view.buyer);
  const tag = inlineDatum(
    outputReferenceTag(TransactionHash.toHex(utxo.transactionId), Number(utxo.index)),
  );

  const reserve = collateralReserve(await client.getWalletUtxos());
  if (!reserve.ok) return { ...reserve, retry: true };
  const built = await client
    .newTx()
    .collectFrom({ inputs: [utxo], redeemer: Data.constr(WITHDRAW, []) })
    .attachScript({ script: masumiValidator() })
    .payToAddress({
      address: buyer,
      assets: Assets.fromLovelace(escrowLovelace),
      datum: tag,
      autoMinUtxo: false,
    })
    .payToAddress({
      address: Address.fromBech32(o.sellerAddress),
      assets: tokens,
      datum: tag,
      autoMinUtxo: true,
    })
    .addSigner({ keyHash: KeyHash.fromHex(seller.payment.hash) })
    .setValidity({ from, to: BigInt(o.now() + VALID_FOR_MS) })
    .build({
      // Exactly the reserve's lovelace: the SDK takes the largest pure-ADA UTxO first, so the
      // collateral is the reserve alone and needs no return output.
      setCollateral: Assets.lovelaceOf(reserve.utxo.assets),
      coinSelection: (available, required) =>
        largestFirstSelection(available.filter(reserve.isNot), required),
    });
  const tx = await built.toTransaction();
  return {
    ok: true,
    plan: {
      buyerAddress: Address.toBech32(buyer),
      sellerAddress: o.sellerAddress,
      asset: assetId(unit),
      amountAtomic: Assets.getByUnit(tokens, unit).toString(),
      buyerLovelace: escrowLovelace.toString(),
      collateralReturnLovelace: view.collateralReturnLovelace.toString(),
      unlockTime: Number(view.unlockTime),
    },
    feeLovelace: tx.body.fee.toString(),
    exUnits: (tx.witnessSet.redeemers?.toArray() ?? []).map((r) => ({
      mem: r.exUnits.mem.toString(),
      steps: r.exUnits.steps.toString(),
    })),
    submit: async () => {
      const signed = await built.sign();
      return TransactionHash.toHex(await signed.submit()).toLowerCase();
    },
  };
}

/** One transaction's outputs as the chain passthrough returns them (Blockfrost). */
export interface ChainTxUtxos {
  outputs: {
    address: string;
    output_index: number;
    amount: { unit: string; quantity: string }[];
    inline_datum: string | null;
    consumed_by_tx?: string | null;
  }[];
}

export type EscrowLocation =
  | { kind: "open"; txHash: string; outputIndex: number }
  /** The escrow left the contract in `spentBy`; `last` is the output that transaction spent. */
  | { kind: "closed"; spentBy: string; last: ChainTxUtxos["outputs"][number] }
  | { kind: "unknown"; reason: string };

/**
 * Where a lock's escrow sits now. It starts from the lock's escrow output, named by its index
 * (without one, the lock transaction must hold exactly one escrow output), then follows every
 * spend that keeps it at the escrow address (SubmitResult does), matching the datum's
 * reference signature, which each continuation keeps.
 */
export async function locateEscrow(
  txUtxos: (txHash: string) => Promise<ChainTxUtxos | null>,
  lockTxHash: string,
  outputIndex?: number,
): Promise<EscrowLocation> {
  const escrow = masumiEscrowAddress(NETWORK);
  const isEscrow = (out: ChainTxUtxos["outputs"][number]) =>
    out.address === escrow &&
    out.inline_datum !== null &&
    parseMasumiLockDatum(out.inline_datum) !== null;
  let txHash = lockTxHash;
  let signature: string | undefined;
  let previous: ChainTxUtxos["outputs"][number] | undefined;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const utxos = await txUtxos(txHash);
    if (!utxos) return { kind: "unknown", reason: `transaction ${txHash} is not on chain yet` };
    let output: ChainTxUtxos["outputs"][number] | undefined;
    if (hop === 0) {
      const escrows = utxos.outputs.filter(isEscrow);
      if (outputIndex !== undefined) {
        output = escrows.find((out) => out.output_index === outputIndex);
        if (!output) {
          return { kind: "unknown", reason: `output ${outputIndex} of the lock is not an escrow` };
        }
      } else if (escrows.length !== 1) {
        return {
          kind: "unknown",
          reason: `the lock transaction has ${escrows.length} escrow outputs; name the output index`,
        };
      } else output = escrows[0];
    } else {
      output = utxos.outputs.find(
        (out) =>
          isEscrow(out) &&
          parseMasumiLockDatum(out.inline_datum as string)?.referenceSignature === signature,
      );
    }
    if (!output) {
      if (!previous) return { kind: "unknown", reason: "the transaction has no escrow output" };
      return { kind: "closed", spentBy: txHash, last: previous };
    }
    signature ??= parseMasumiLockDatum(output.inline_datum as string)?.referenceSignature;
    if (!output.consumed_by_tx) {
      return { kind: "open", txHash, outputIndex: output.output_index };
    }
    previous = output;
    txHash = output.consumed_by_tx;
  }
  return { kind: "unknown", reason: "the escrow moved more often than a lock should" };
}

/**
 * Whether the transaction that closed an escrow was its release, as this market builds one:
 * Seller A received the escrow's token, and the buyer all of the escrow's lovelace (at least
 * the collateral). Read from the chain, so a release that landed while the market was down
 * still counts, and a refund never does.
 */
export async function releaseOf(
  txUtxos: (txHash: string) => Promise<ChainTxUtxos | null>,
  closed: Extract<EscrowLocation, { kind: "closed" }>,
  sellerAddress: string,
): Promise<ReleasePlan | null> {
  const view = closed.last.inline_datum ? parseMasumiLockDatum(closed.last.inline_datum) : null;
  const token = closed.last.amount.find((a) => a.unit !== "lovelace");
  const tx = await txUtxos(closed.spentBy);
  if (!view || !token || !tx) return null;
  const buyerAddress = Address.toBech32(
    addressFromCredentials(view.buyerReturnAddress ?? view.buyer),
  );
  const toSeller = tx.outputs.find(
    (out) =>
      out.address === sellerAddress &&
      out.amount.some((a) => a.unit === token.unit && BigInt(a.quantity) >= BigInt(token.quantity)),
  );
  const escrowLovelace = BigInt(
    closed.last.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0",
  );
  const owed =
    escrowLovelace > view.collateralReturnLovelace ? escrowLovelace : view.collateralReturnLovelace;
  const toBuyer = tx.outputs.find(
    (out) =>
      out.address === buyerAddress &&
      out.amount.some((a) => a.unit === "lovelace" && BigInt(a.quantity) >= owed),
  );
  if (!toSeller || !toBuyer) return null;
  return {
    buyerAddress,
    sellerAddress,
    asset: assetId(token.unit),
    amountAtomic: token.quantity,
    buyerLovelace: toBuyer.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0",
    collateralReturnLovelace: view.collateralReturnLovelace.toString(),
    unlockTime: Number(view.unlockTime),
  };
}

export type ReleaseOutcome =
  | {
      ok: true;
      dryRun: boolean;
      /** Empty for a dry run. */
      txHash: string;
      plan: ReleasePlan;
      feeLovelace: string;
      exUnits: { mem: string; steps: string }[];
    }
  | {
      ok: false;
      reason: string;
      /** Worth trying again later: the chain was unreachable, or the unlock is still ahead. */
      retry: boolean;
      /** The escrow was already released, in this transaction (seen on chain). */
      releasedIn?: { txHash: string; plan: ReleasePlan };
    };

/**
 * Releases escrows as Seller A, one transaction at a time with result submissions. A dry run
 * builds and evaluates the Withdraw and signs nothing.
 */
export function createEscrowReleaser(o: { chain: SellerChain; now?: () => number }) {
  const now = o.now ?? Date.now;
  const { chain } = o;
  const base = chain.chainUrl.replace(/\/+$/, "");

  async function txUtxos(txHash: string): Promise<ChainTxUtxos | null> {
    const res = await fetch(`${base}/txs/${txHash}/utxos`, { signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`the chain answered ${res.status}`);
    return (await res.json()) as ChainTxUtxos;
  }

  async function run(
    lockTxHash: string,
    outputIndex: number | undefined,
    dryRun: boolean,
  ): Promise<ReleaseOutcome> {
    const where = await locateEscrow(txUtxos, lockTxHash, outputIndex);
    if (where.kind === "unknown") return { ok: false, reason: where.reason, retry: true };
    if (where.kind === "closed") {
      const plan = await releaseOf(txUtxos, where, chain.sellerAddress);
      return {
        ok: false,
        reason: `the escrow was already spent, by ${where.spentBy}`,
        retry: false,
        ...(plan ? { releasedIn: { txHash: where.spentBy, plan } } : {}),
      };
    }
    const ref = new TransactionInput.TransactionInput({
      transactionId: TransactionHash.fromHex(where.txHash),
      index: BigInt(where.outputIndex),
    });
    const [utxo] = await chain.client.getUtxosByOutRef([ref]);
    if (!utxo) return { ok: false, reason: "the escrow output is not visible", retry: true };
    const built = await buildRelease(chain.client, utxo, {
      sellerAddress: chain.sellerAddress,
      now,
    });
    if (!built.ok) return built;
    const { plan, feeLovelace, exUnits } = built;
    if (dryRun) return { ok: true, dryRun: true, txHash: "", plan, feeLovelace, exUnits };
    const txHash = await built.submit();
    return { ok: true, dryRun: false, txHash, plan, feeLovelace, exUnits };
  }

  /**
   * Never throws: a failure is an outcome. A build or evaluation error submits nothing.
   * `outputIndex` names the lock's escrow output (from escrow.locked).
   */
  return function release(
    lockTxHash: string,
    options: { dryRun?: boolean; outputIndex?: number } = {},
  ): Promise<ReleaseOutcome> {
    return chain.enqueue(() =>
      run(lockTxHash, options.outputIndex, options.dryRun === true).catch((err: unknown) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : String(err),
        retry: true,
      })),
    );
  };
}

export type EscrowReleaser = ReturnType<typeof createEscrowReleaser>;

/** The facilitator's chain passthrough: one transaction's outputs, or null if not on chain. */
export function chainTxUtxos(chainUrl: string) {
  const base = chainUrl.replace(/\/+$/, "");
  return async (txHash: string): Promise<ChainTxUtxos | null> => {
    const res = await fetch(`${base}/txs/${txHash}/utxos`, { signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`the chain answered ${res.status}`);
    return (await res.json()) as ChainTxUtxos;
  };
}

export interface CheckedRefund {
  lockTxHash: string;
  txHash: string;
  buyerAddress: string;
  amountAtomic: string;
  asset: string;
  collateralReturnLovelace: string;
}

/**
 * PR-16b: whether `txHash` refunded the lock: it closed the escrow, and one of its outputs
 * gave the buyer all of the escrow's lovelace and its token. Every value comes from the chain,
 * never from the report.
 */
export async function checkRefund(
  txUtxos: (txHash: string) => Promise<ChainTxUtxos | null>,
  lock: { txHash: string; outputIndex?: number },
  txHash: string,
): Promise<{ ok: true; refund: CheckedRefund } | { ok: false; reason: string }> {
  const where = await locateEscrow(txUtxos, lock.txHash, lock.outputIndex);
  if (where.kind !== "closed") {
    return {
      ok: false,
      reason: where.kind === "open" ? "the escrow is still open" : where.reason,
    };
  }
  if (where.spentBy !== txHash) {
    return { ok: false, reason: `the escrow was closed by ${where.spentBy}, not ${txHash}` };
  }
  const view = where.last.inline_datum ? parseMasumiLockDatum(where.last.inline_datum) : null;
  const token = where.last.amount.find((a) => a.unit !== "lovelace");
  const lovelace = where.last.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0";
  const tx = await txUtxos(txHash);
  if (!view || !token || !tx)
    return { ok: false, reason: "the escrow or the refund is unreadable" };
  // A spend after a result was submitted is the seller's release, never a refund.
  if (!REFUNDABLE.has(view.state) || view.resultHash !== "") {
    return { ok: false, reason: "the escrow held a result: its spend is a release, not a refund" };
  }
  const buyerAddress = Address.toBech32(
    addressFromCredentials(view.buyerReturnAddress ?? view.buyer),
  );
  const everything = tx.outputs.some(
    (out) =>
      out.address === buyerAddress &&
      where.last.amount.every(
        (a) =>
          BigInt(out.amount.find((b) => b.unit === a.unit)?.quantity ?? "0") >= BigInt(a.quantity),
      ),
  );
  if (!everything) return { ok: false, reason: "the buyer did not get all of the escrow back" };
  return {
    ok: true,
    refund: {
      lockTxHash: lock.txHash,
      txHash,
      buyerAddress,
      amountAtomic: token.quantity,
      asset: assetId(token.unit),
      collateralReturnLovelace: lovelace,
    },
  };
}
