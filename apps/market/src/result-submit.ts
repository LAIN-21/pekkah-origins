import {
  Address,
  Assets,
  Client,
  Data,
  InlineDatum,
  KeyHash,
  preprod,
  TransactionHash,
  TransactionInput,
  type UTxO,
} from "@evolution-sdk/evolution";
import { largestFirstSelection } from "@evolution-sdk/evolution/sdk/builders/CoinSelection";
import { NETWORK } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import {
  addressCredentials,
  inlineDatum,
  MASUMI_DEFAULT_DEPLOYMENT,
  masumiEscrowAddress,
} from "@x402/cardano";
import { masumiValidator } from "./masumi-validator.js";

// Masumi's SubmitResult (PR-10b, vested_pay V2): the seller records the delivered result's hash
// in the escrow datum. The funds stay locked in escrow; nothing is withdrawn or released.

/** vested_pay V2 `Action`: Withdraw 0 … SubmitResult 5 … */
const SUBMIT_RESULT = 5n;
/** vested_pay V2 `State`: FundsLocked 0, ResultSubmitted 1, … */
const FUNDS_LOCKED = 0n;
const RESULT_SUBMITTED = 1n;
/** Datum field positions (19 fields, vested_pay V2). */
const F = {
  resultHash: 11,
  submitResultTime: 13,
  sellerCooldown: 16,
  buyerCooldown: 17,
  state: 18,
};
/** How long a submit-result transaction may wait to land. */
const VALID_FOR_MS = 180_000;
/**
 * Collateral is a pure-ADA wallet UTxO of at least this much, used whole: a token-carrying
 * collateral would need a return output with its own minimum ADA. It covers 150% of this
 * transaction's fee (well under 1 tADA) with room. Only a failed script takes it, and
 * evaluation rules that out before any submit.
 */
const MIN_COLLATERAL = 2_000_000n;

/**
 * The escrow datum after SubmitResult, from the locked one: the result hash set, the state
 * ResultSubmitted, the buyer's cooldown cleared and the seller's at least `sellerCooldownTime`.
 * Every other field must stay as it is (the validator checks each one).
 */
export function submittedDatum(
  locked: Data.Data,
  resultHash: string,
  sellerCooldownTime: bigint,
): Data.Constr {
  if (!Data.isConstr(locked) || locked.index !== 0n || locked.fields.length !== 19) {
    throw new Error("not a vested_pay V2 escrow datum");
  }
  const state = locked.fields[F.state];
  if (!Data.isConstr(state) || state.index !== FUNDS_LOCKED) {
    throw new Error("the escrow is not in FundsLocked");
  }
  if (!/^[0-9a-f]{64}$/.test(resultHash)) throw new Error("the result hash must be 32 bytes");
  const fields = [...locked.fields];
  fields[F.resultHash] = Data.bytearray(resultHash);
  fields[F.sellerCooldown] = Data.int(sellerCooldownTime);
  fields[F.buyerCooldown] = Data.int(0n);
  fields[F.state] = Data.constr(RESULT_SUBMITTED, []);
  return Data.constr(0n, fields);
}

/** The datum's submit_result_time (POSIX ms). */
function submitResultTime(datum: Data.Constr): bigint {
  const value = datum.fields[F.submitResultTime];
  if (typeof value !== "bigint") throw new Error("the datum has no submit_result_time");
  return value;
}

export interface ResultSubmitterOptions {
  /** The facilitator's Blockfrost passthrough (it adds the project id). */
  chainUrl: string;
  /** SELLER_A_MNEMONIC, normalized: the market already holds it to sign escrow terms. */
  sellerMnemonic: string;
  sellerAddress: string;
  log: Logger;
  now?: () => number;
}

export interface SubmitResultInput {
  lockTxHash: string;
  /** The escrow output's index in the lock transaction. */
  outputIndex: number;
  /** sha256 of the delivered result: what the seller commits to on chain. */
  resultHash: string;
  /** Tests and dry runs: the escrow UTxO itself; then nothing is signed or submitted. */
  dryRunUtxo?: UTxO.UTxO;
}

export type SubmitResultOutcome =
  | { ok: true; txHash: string; dryRun: boolean; feeLovelace: string }
  | { ok: false; reason: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seller A's wallet over the facilitator's passthrough. A wallet error can name words, so its
 * message never leaves here. */
function sellerClient(o: ResultSubmitterOptions) {
  try {
    return Client.make(preprod)
      .withBlockfrost({ baseUrl: o.chainUrl })
      .withSeed({ mnemonic: o.sellerMnemonic });
  } catch {
    throw new Error("could not create the Seller A wallet");
  }
}

/**
 * The submitter, or null with the reason logged: a failure here disables escrow result
 * submission only, never the market (as with a Masumi seller key that does not match).
 */
export function tryCreateResultSubmitter(o: ResultSubmitterOptions) {
  try {
    return createResultSubmitter(o);
  } catch (err) {
    o.log.error(
      `Escrow result submission disabled: ${err instanceof Error ? err.message : "setup failed"}`,
    );
    return null;
  }
}

/**
 * Submits escrow results as Seller A, one transaction at a time (one wallet). Chain reads,
 * script evaluation and the submit all go through the facilitator.
 */
export function createResultSubmitter(o: ResultSubmitterOptions) {
  const now = o.now ?? Date.now;
  // The checks whose errors name no secret come first.
  const script = masumiValidator();
  const escrowAddress = masumiEscrowAddress(NETWORK);
  const seller = addressCredentials(o.sellerAddress);
  if (seller.payment.isScript) throw new Error("the Masumi seller must be a key address");
  const sellerKeyHash = KeyHash.fromHex(seller.payment.hash);
  const cooldownMs = BigInt(MASUMI_DEFAULT_DEPLOYMENT.cooldownPeriod);
  const client = sellerClient(o);
  let queue: Promise<unknown> = Promise.resolve();

  /** The escrow output, once the facilitator's view of the chain has it (polls 5 s apart). */
  async function lockedUtxo(input: SubmitResultInput): Promise<UTxO.UTxO> {
    if (input.dryRunUtxo) return input.dryRunUtxo;
    const ref = new TransactionInput.TransactionInput({
      transactionId: TransactionHash.fromHex(input.lockTxHash),
      index: BigInt(input.outputIndex),
    });
    for (let attempt = 1; ; attempt++) {
      const [utxo] = await client.getUtxosByOutRef([ref]).catch(() => []);
      if (utxo) return utxo;
      if (attempt >= 12) throw new Error("the escrow output is not visible on chain");
      await sleep(5_000);
    }
  }

  async function run(input: SubmitResultInput): Promise<SubmitResultOutcome> {
    const utxo = await lockedUtxo(input);
    if (Address.toBech32(utxo.address) !== escrowAddress) {
      return { ok: false, reason: "the output is not at the Masumi escrow address" };
    }
    if (!(utxo.datumOption instanceof InlineDatum.InlineDatum)) {
      return { ok: false, reason: "the escrow output has no inline datum" };
    }
    const locked = utxo.datumOption.data;
    if (!Data.isConstr(locked)) return { ok: false, reason: "the escrow datum is malformed" };
    // The validity range must start at or after the current seller cooldown (0 for a fresh
    // lock) and end before submit_result_time; the new seller cooldown must be at least the
    // range's end plus the deployment's cooldown period.
    const from = BigInt(now() - 60_000);
    const deadline = submitResultTime(locked);
    const to = BigInt(Math.min(now() + VALID_FOR_MS, Number(deadline) - 2_000));
    if (to <= BigInt(now() + 20_000)) {
      return { ok: false, reason: "the submit-result window has closed" };
    }
    const datum = submittedDatum(locked, input.resultHash, to + cooldownMs + 1_000n);
    // Reserve the largest pure-ADA UTxO as collateral and pay the fee from the others, so the
    // reserve survives for the next submit.
    const wallet = await client.getWalletUtxos();
    const pure = wallet
      .filter((u) => !Assets.hasMultiAsset(u.assets) && u.scriptRef === undefined)
      .sort((a, b) => Number(Assets.lovelaceOf(b.assets) - Assets.lovelaceOf(a.assets)));
    const reserve = pure[0];
    if (!reserve || Assets.lovelaceOf(reserve.assets) < MIN_COLLATERAL) {
      return {
        ok: false,
        reason: "Seller A needs a pure-ADA UTxO of at least 2 tADA for collateral",
      };
    }
    const isReserve = (u: UTxO.UTxO) =>
      TransactionHash.toHex(u.transactionId) === TransactionHash.toHex(reserve.transactionId) &&
      u.index === reserve.index;
    const built = await client
      .newTx()
      .collectFrom({ inputs: [utxo], redeemer: Data.constr(SUBMIT_RESULT, []) })
      .attachScript({ script })
      .payToAddress({
        address: utxo.address,
        assets: utxo.assets,
        datum: inlineDatum(datum),
        autoMinUtxo: false,
      })
      .addSigner({ keyHash: sellerKeyHash })
      .setValidity({ from, to })
      .build({
        passAdditionalUtxos: input.dryRunUtxo !== undefined,
        // Exactly the reserve's lovelace: the SDK takes the largest pure-ADA UTxO first, so the
        // collateral is the reserve alone and needs no return output.
        setCollateral: Assets.lovelaceOf(reserve.assets),
        coinSelection: (available, required) =>
          largestFirstSelection(
            available.filter((u) => !isReserve(u)),
            required,
          ),
      });
    const tx = await built.toTransaction();
    const feeLovelace = tx.body.fee.toString();
    if (input.dryRunUtxo) {
      return { ok: true, dryRun: true, txHash: "", feeLovelace };
    }
    const signed = await built.sign();
    const txHash = TransactionHash.toHex(await signed.submit()).toLowerCase();
    return { ok: true, dryRun: false, txHash, feeLovelace };
  }

  /** Never throws: a failure is an outcome. Build or evaluation errors submit nothing. */
  return function submit(input: SubmitResultInput): Promise<SubmitResultOutcome> {
    const next = queue.then(() =>
      run(input).catch((err: unknown) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : String(err),
      })),
    );
    queue = next;
    return next;
  };
}
