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
 * Collateral comes from a pure-ADA wallet UTxO of at least this much: a token-carrying one
 * would need its tokens returned too. It covers 150% of a script transaction's fee (well
 * under 1 tADA) with room. Only a failed script takes it, and evaluation rules that out
 * before any submit.
 */
const MIN_COLLATERAL = 2_000_000n;
/**
 * The most a script transaction puts up. The SDK takes the reserve and sends the rest back
 * in a collateral-return output, so even a failed script costs at most this, however large
 * the reserve is (a funding can make it thousands of tADA).
 */
export const MAX_COLLATERAL = 5_000_000n;
/**
 * The least a collateral return may hold: above a pure-ADA output's minimum (about 1 tADA).
 * The SDK refuses to build when the return falls below that minimum.
 */
const MIN_RETURN = 1_500_000n;

/**
 * How much of a reserve to put up: all of it up to 5 tADA; above that, 5 tADA, unless the
 * return would fall under its minimum, then the reserve less that minimum (still over 3.5 tADA).
 */
export function collateralFor(lovelace: bigint): bigint {
  if (lovelace <= MAX_COLLATERAL) return lovelace;
  return lovelace - MAX_COLLATERAL >= MIN_RETURN ? MAX_COLLATERAL : lovelace - MIN_RETURN;
}

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

export interface SellerChainOptions {
  /** The facilitator's Blockfrost passthrough (it adds the project id). */
  chainUrl: string;
  /** SELLER_A_MNEMONIC, normalized: the market already holds it to sign escrow terms. */
  sellerMnemonic: string;
  sellerAddress: string;
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
export function sellerClient(o: { chainUrl: string; sellerMnemonic: string }) {
  try {
    return Client.make(preprod)
      .withBlockfrost({ baseUrl: o.chainUrl })
      .withSeed({ mnemonic: o.sellerMnemonic });
  } catch {
    throw new Error("could not create the Seller A wallet");
  }
}

export type SellerClient = ReturnType<typeof sellerClient>;

const sameRef = (a: UTxO.UTxO, b: UTxO.UTxO) =>
  TransactionHash.toHex(a.transactionId) === TransactionHash.toHex(b.transactionId) &&
  a.index === b.index;

/**
 * The collateral reserve: the largest pure-ADA wallet UTxO, which must hold at least 2 tADA.
 * The SDK picks the same one for collateral (pure ADA first, largest first). `collateral` is
 * the amount to put up: the whole reserve up to 5 tADA, never more. Fees and min-ADA come
 * from the other UTxOs (`isNot` filters the reserve out of coin selection), so it survives for
 * the next script transaction.
 */
export function collateralReserve(
  wallet: readonly UTxO.UTxO[],
):
  | { ok: true; utxo: UTxO.UTxO; collateral: bigint; isNot: (u: UTxO.UTxO) => boolean }
  | { ok: false; reason: string } {
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
  const lovelace = Assets.lovelaceOf(reserve.assets);
  return {
    ok: true,
    utxo: reserve,
    collateral: collateralFor(lovelace),
    isNot: (u) => !sameRef(u, reserve),
  };
}

/**
 * Seller A on chain: its wallet over the facilitator's passthrough (chain reads, script
 * evaluation and submits all go through the facilitator), and one queue for its script
 * transactions, result submissions and releases alike: one wallet, never two in flight.
 */
export interface SellerChain {
  client: SellerClient;
  chainUrl: string;
  sellerAddress: string;
  sellerKeyHash: KeyHash.KeyHash;
  /** Runs a seller transaction once the previous one has ended, however it ended. */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

export function createSellerChain(o: SellerChainOptions): SellerChain {
  // The checks whose errors name no secret come first.
  masumiValidator();
  const seller = addressCredentials(o.sellerAddress);
  if (seller.payment.isScript) throw new Error("the Masumi seller must be a key address");
  const client = sellerClient(o);
  let queue: Promise<unknown> = Promise.resolve();
  return {
    client,
    chainUrl: o.chainUrl,
    sellerAddress: o.sellerAddress,
    sellerKeyHash: KeyHash.fromHex(seller.payment.hash),
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const next = queue.then(task);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/**
 * Seller A's chain access, or null with the reason logged: a failure here disables escrow
 * result submission and release only, never the market (as with a Masumi seller key that
 * does not match).
 */
export function tryCreateSellerChain(o: SellerChainOptions & { log: Logger }): SellerChain | null {
  try {
    return createSellerChain(o);
  } catch (err) {
    o.log.error(
      `Escrow result submission and release disabled: ${err instanceof Error ? err.message : "setup failed"}`,
    );
    return null;
  }
}

export interface ResultSubmitterOptions {
  chain: SellerChain;
  now?: () => number;
}

/** Submits escrow results as Seller A, through the seller's transaction queue. */
export function createResultSubmitter(o: ResultSubmitterOptions) {
  const now = o.now ?? Date.now;
  const script = masumiValidator();
  const escrowAddress = masumiEscrowAddress(NETWORK);
  const cooldownMs = BigInt(MASUMI_DEFAULT_DEPLOYMENT.cooldownPeriod);
  const { client, sellerKeyHash } = o.chain;

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
    const reserve = collateralReserve(await client.getWalletUtxos());
    if (!reserve.ok) return reserve;
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
        // At most 5 tADA of the reserve; the SDK returns the rest (collateralReserve).
        setCollateral: reserve.collateral,
        coinSelection: (available, required) =>
          largestFirstSelection(available.filter(reserve.isNot), required),
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
    return o.chain.enqueue(() =>
      run(input).catch((err: unknown) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : String(err),
      })),
    );
  };
}
