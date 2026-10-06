import {
  Address,
  Assets,
  Data,
  InlineDatum,
  KeyHash,
  ScriptHash,
  TransactionHash,
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
import { collateralReserve, type SellerClient } from "./result-submit.js";

// Masumi's Withdraw (PR-16, vested_pay V2): after unlock_time, Seller A collects the price and
// the buyer's collateral goes back to the buyer, both in one transaction.

/** vested_pay V2 `Action`: Withdraw 0 … */
const WITHDRAW = 0n;
/** vested_pay V2 `State`: FundsLocked 0, ResultSubmitted 1, … */
const RESULT_SUBMITTED = 1n;
/** How long a release transaction may wait to land. */
const VALID_FOR_MS = 180_000;
/** The validity range starts this long after unlock_time, which covers slot rounding. */
const AFTER_UNLOCK_MS = 1_000n;

export interface ReleaseInput {
  /** The escrow UTxO to spend: after SubmitResult it is that transaction's escrow output. */
  txHash: string;
  outputIndex: number;
}

export interface ReleasePlan {
  buyerAddress: string;
  sellerAddress: string;
  /** Every non-ADA unit in the escrow goes to the seller. */
  assets: Record<string, string>;
  collateralReturnLovelace: string;
  /** All of the escrow's lovelace, which goes back to the buyer. */
  buyerLovelace: string;
  unlockTime: number;
}

export type BuiltRelease =
  | {
      ok: true;
      plan: ReleasePlan;
      feeLovelace: string;
      exUnits: { mem: string; steps: string }[];
      sign: () => Promise<string>;
    }
  | { ok: false; reason: string };

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

/** vested_pay tags each output it counts with the spent UTxO's reference: the Plutus V3
 * `OutputReference`, `Constr 0 [tx hash bytes, output index]`. */
export function outputReferenceTag(txHash: string, outputIndex: number): Data.Constr {
  return Data.constr(0n, [Data.bytearray(txHash), Data.int(BigInt(outputIndex))]);
}

/**
 * Builds and evaluates the Withdraw for one escrow UTxO, without signing it. Refuses unless the
 * escrow is ResultSubmitted, its seller is Seller A and its unlock time has passed. The buyer
 * gets all of the escrow's lovelace (at least the collateral); Seller A gets the tokens, with
 * their min-ADA and the fee paid from its own UTxOs, never from the collateral reserve.
 */
export async function buildRelease(
  client: SellerClient,
  utxo: UTxO.UTxO,
  input: ReleaseInput,
  o: { sellerAddress: string; now: () => number },
): Promise<BuiltRelease> {
  if (Address.toBech32(utxo.address) !== masumiEscrowAddress(NETWORK)) {
    return { ok: false, reason: "the output is not at the Masumi escrow address" };
  }
  if (!(utxo.datumOption instanceof InlineDatum.InlineDatum)) {
    return { ok: false, reason: "the escrow output has no inline datum" };
  }
  const view = parseMasumiLockDatum(utxo.datumOption.data);
  if (!view) return { ok: false, reason: "the escrow datum is malformed" };
  if (view.state !== RESULT_SUBMITTED) {
    return { ok: false, reason: `the escrow is in state ${view.state}, not ResultSubmitted` };
  }
  const seller = addressCredentials(o.sellerAddress);
  if (!sameCredentials(view.seller, seller)) {
    return { ok: false, reason: "the escrow's seller is not Seller A" };
  }
  if (view.sellerReturnAddress) {
    return { ok: false, reason: "the escrow names a seller return address" };
  }
  const from = view.unlockTime + AFTER_UNLOCK_MS;
  if (BigInt(o.now()) < from) return { ok: false, reason: "the escrow is not unlocked yet" };
  const escrowLovelace = Assets.lovelaceOf(utxo.assets);
  if (escrowLovelace < view.collateralReturnLovelace) {
    return { ok: false, reason: "the escrow holds less lovelace than the collateral" };
  }
  const buyer = addressFromCredentials(view.buyerReturnAddress ?? view.buyer);
  const sellerAddress = Address.fromBech32(o.sellerAddress);
  const tokens = Assets.withoutLovelace(utxo.assets);
  const tag = inlineDatum(outputReferenceTag(input.txHash, input.outputIndex));

  const wallet = await client.getWalletUtxos();
  const reserve = collateralReserve(wallet);
  if (!reserve.ok) return reserve;
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
    .payToAddress({ address: sellerAddress, assets: tokens, datum: tag, autoMinUtxo: true })
    .addSigner({ keyHash: KeyHash.fromHex(seller.payment.hash) })
    .setValidity({ from, to: BigInt(o.now() + VALID_FOR_MS) })
    .build({
      setCollateral: Assets.lovelaceOf(reserve.utxo.assets),
      coinSelection: (available, required) =>
        largestFirstSelection(available.filter(reserve.isNot), required),
    });
  const tx = await built.toTransaction();
  const redeemers = tx.witnessSet.redeemers?.toArray() ?? [];
  const assets: Record<string, string> = {};
  for (const unit of Assets.getUnits(tokens)) {
    if (unit !== "lovelace") assets[unit] = Assets.getByUnit(tokens, unit).toString();
  }
  return {
    ok: true,
    plan: {
      buyerAddress: Address.toBech32(buyer),
      sellerAddress: o.sellerAddress,
      assets,
      collateralReturnLovelace: view.collateralReturnLovelace.toString(),
      buyerLovelace: escrowLovelace.toString(),
      unlockTime: Number(view.unlockTime),
    },
    feeLovelace: tx.body.fee.toString(),
    exUnits: redeemers.map((r) => ({
      mem: r.exUnits.mem.toString(),
      steps: r.exUnits.steps.toString(),
    })),
    sign: async () => {
      const signed = await built.sign();
      return TransactionHash.toHex(await signed.submit()).toLowerCase();
    },
  };
}
