import {
  Address,
  Assets,
  Client,
  Data,
  KeyHash,
  preprod,
  TransactionHash,
  TransactionInput,
  type UTxO,
} from "@evolution-sdk/evolution";
import { largestFirstSelection } from "@evolution-sdk/evolution/sdk/builders/CoinSelection";
import { masumiValidator } from "@pekkah/payments";
import { explorerTxUrl, NETWORK } from "@pekkah/protocol";
import {
  addressCredentials,
  inlineDatum,
  type MasumiAddressCredentials,
  type MasumiCredential,
  type MasumiDatumView,
  masumiEscrowAddress,
  parseMasumiLockDatum,
} from "@x402/cardano";

// Masumi's WithdrawRefund (PR-16b, vested_pay V2): my agent, the buyer, takes back a lock whose
// seller submitted no result by submit_result_time: the price and the collateral, both back
// to the buyer. Built here, evaluated before it is signed, and signed with the buyer's key.

/** vested_pay V2 `Action`: … WithdrawRefund 3 … */
const WITHDRAW_REFUND = 3n;
/** vested_pay V2 `State`: FundsLocked 0, RefundRequested 2, RefundAuthorized 5. */
const REFUNDABLE = new Set([0n, 2n, 5n]);
const REFUND_AUTHORIZED = 5n;
/** How long a refund transaction may wait to land. */
const VALID_FOR_MS = 180_000;
/** The validity range starts this long after submit_result_time, which covers slot rounding. */
const AFTER_DEADLINE_MS = 1_000n;
/** At most this much of the collateral UTxO is put up; the SDK returns the rest. */
export const MAX_COLLATERAL = 5_000_000n;
/** The least a collateral return may hold: the SDK refuses one under the minimum UTxO. */
const MIN_RETURN = 1_500_000n;

export type BuyerClient = ReturnType<typeof buyerClient>;

/** The buyer's wallet, reading the chain from Blockfrost directly (the buyer may call it). */
export function buyerClient(o: {
  baseUrl: string;
  projectId: string;
  mnemonic: string;
  accountIndex: number;
}) {
  try {
    return Client.make(preprod)
      .withBlockfrost({ baseUrl: o.baseUrl, projectId: o.projectId })
      .withSeed({ mnemonic: o.mnemonic, accountIndex: o.accountIndex });
  } catch {
    // A wallet error can name words, so its message never leaves here.
    throw new Error("could not create the buyer wallet");
  }
}

export interface LockRef {
  txHash: string;
  outputIndex: number;
}

/** `<lockTxHash>#<index>`, as the CLI takes it. */
export function parseLockRef(value: string): LockRef | null {
  const match = /^([0-9a-f]{64})#(\d{1,4})$/.exec(value.trim().toLowerCase());
  return match ? { txHash: match[1] as string, outputIndex: Number(match[2]) } : null;
}

const sameCredential = (a: MasumiCredential | undefined, b: MasumiCredential | undefined) =>
  a?.isScript === b?.isScript && a?.hash === b?.hash;

/** Why this wallet can't refund this escrow now, or null when it can. */
export function refundRefusal(
  view: MasumiDatumView,
  wallet: MasumiAddressCredentials,
  now: number,
): string | null {
  if (!REFUNDABLE.has(view.state)) {
    return `the escrow is in state ${view.state}: a result was submitted, or it is disputed`;
  }
  if (view.resultHash !== "") return "the escrow holds a result hash";
  if (!sameCredential(view.buyer.payment, wallet.payment)) {
    return "this wallet is not the escrow's buyer";
  }
  if (view.state !== REFUND_AUTHORIZED && BigInt(now) < view.submitResultTime + AFTER_DEADLINE_MS) {
    return "the submit-result deadline has not passed yet";
  }
  return null;
}

/** One output as Blockfrost's GET /txs/:hash/utxos returns it. */
export interface ChainOutput {
  address: string;
  output_index: number;
  amount: { unit: string; quantity: string }[];
  inline_datum: string | null;
  consumed_by_tx?: string | null;
}

/**
 * Whether the transaction that spent an escrow gave all of it back to the buyer: one output to
 * the buyer with at least the escrow's lovelace and each of its tokens. A re-run reports such a
 * refund instead of sending another.
 */
export function refundedIn(escrow: ChainOutput, spending: ChainOutput[], buyer: string): boolean {
  return spending.some(
    (out) =>
      out.address === buyer &&
      escrow.amount.every(
        (a) =>
          BigInt(out.amount.find((b) => b.unit === a.unit)?.quantity ?? "0") >= BigInt(a.quantity),
      ),
  );
}

/** vested_pay counts an output only when its inline datum is the spent UTxO's reference. */
export function outputReferenceTag(txHash: string, outputIndex: number): Data.Constr {
  return Data.constr(0n, [Data.bytearray(txHash), Data.int(BigInt(outputIndex))]);
}

/** What the market is told about a refund (escrow.refunded); it checks all of it on chain. */
export interface RefundReport {
  lockTxHash: string;
  txHash: string;
  buyerAddress: string;
  amountAtomic: string;
  asset: string;
  collateralReturnLovelace: string;
  explorerUrl: string;
}

export function refundReport(lock: LockRef, txHash: string, escrow: ChainOutput, buyer: string) {
  const token = escrow.amount.find((a) => a.unit !== "lovelace");
  const unit = token?.unit ?? "";
  return {
    lockTxHash: lock.txHash,
    txHash,
    buyerAddress: buyer,
    amountAtomic: token?.quantity ?? "0",
    asset: `${unit.slice(0, 56)}.${unit.slice(56)}`,
    collateralReturnLovelace: escrow.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0",
    explorerUrl: explorerTxUrl(txHash),
  } satisfies RefundReport;
}

export type RefundOutcome =
  | {
      ok: true;
      /** The refund was already on chain: nothing was sent. */
      alreadyRefunded: boolean;
      dryRun: boolean;
      report: RefundReport;
      feeLovelace?: string;
      exUnits?: { mem: string; steps: string }[];
      /** The self-transfer that made a pure-ADA collateral UTxO, if one was needed. */
      collateralTxHash?: string;
    }
  | { ok: false; reason: string };

export interface RefundDeps {
  client: BuyerClient;
  /** Blockfrost's GET /txs/:hash/utxos, or null while the transaction is not on chain. */
  txUtxos: (txHash: string) => Promise<{ outputs: ChainOutput[] } | null>;
  /** Whether Blockfrost shows the transaction (polled 5 s apart). */
  waitForTx: (txHash: string) => Promise<boolean>;
  now: () => number;
  log: (line: string) => void;
}

/**
 * Refunds one lock to the buyer, or reports the refund already on chain. The transaction is
 * evaluated before it is signed; a dry run stops there and signs nothing.
 */
export async function refund(
  lock: LockRef,
  d: RefundDeps,
  dryRun: boolean,
): Promise<RefundOutcome> {
  const lockTx = await d.txUtxos(lock.txHash);
  if (!lockTx) return { ok: false, reason: "the lock transaction is not on chain" };
  const escrow = lockTx.outputs.find((o) => o.output_index === lock.outputIndex);
  if (!escrow || escrow.address !== masumiEscrowAddress(NETWORK) || !escrow.inline_datum) {
    return { ok: false, reason: `output ${lock.outputIndex} is not a Masumi escrow output` };
  }
  const view = parseMasumiLockDatum(escrow.inline_datum);
  if (!view) return { ok: false, reason: "the escrow datum is malformed" };
  const walletAddress = await d.client.address();
  const buyer = Address.toBech32(walletAddress);

  if (escrow.consumed_by_tx) {
    const spending = await d.txUtxos(escrow.consumed_by_tx);
    if (spending && refundedIn(escrow, spending.outputs, buyer)) {
      const report = refundReport(lock, escrow.consumed_by_tx, escrow, buyer);
      return { ok: true, alreadyRefunded: true, dryRun, report };
    }
    return {
      ok: false,
      reason: `the escrow was spent by ${escrow.consumed_by_tx}, and not as a refund to this wallet`,
    };
  }
  const refusal = refundRefusal(view, addressCredentials(buyer), d.now());
  if (refusal) return { ok: false, reason: refusal };

  // Collateral: a pure-ADA wallet UTxO, of which at most 5 tADA is put up. Without one, a real
  // refund first makes one with a self-transfer; a dry run lets the SDK pick and signs nothing.
  let wallet = await d.client.getWalletUtxos();
  let reserve = pureAdaReserve(wallet);
  let collateralTxHash: string | undefined;
  if (!reserve && !dryRun) {
    collateralTxHash = await selfTransfer(d.client, walletAddress);
    d.log(`collateral ${explorerTxUrl(collateralTxHash)} (5 tADA to myself, for collateral)`);
    if (!(await d.waitForTx(collateralTxHash))) {
      return { ok: false, reason: "the collateral self-transfer is not on chain yet; run again" };
    }
    // Blockfrost's address index can trail the transaction by a few seconds: read again.
    for (let i = 0; i < 6 && !reserve; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 5_000));
      wallet = await d.client.getWalletUtxos();
      reserve = pureAdaReserve(wallet);
    }
    if (!reserve)
      return { ok: false, reason: "no pure-ADA UTxO after the self-transfer; run again" };
  }

  const [utxo] = await d.client.getUtxosByOutRef([
    new TransactionInput.TransactionInput({
      transactionId: TransactionHash.fromHex(lock.txHash),
      index: BigInt(lock.outputIndex),
    }),
  ]);
  if (!utxo) return { ok: false, reason: "the escrow output is not visible" };
  const keyHash = addressCredentials(buyer).payment;
  if (keyHash.isScript) return { ok: false, reason: "the buyer must be a key address" };
  const from =
    view.state === REFUND_AUTHORIZED
      ? BigInt(d.now() - 60_000)
      : view.submitResultTime + AFTER_DEADLINE_MS;
  const built = await d.client
    .newTx()
    .collectFrom({ inputs: [utxo], redeemer: Data.constr(WITHDRAW_REFUND, []) })
    .attachScript({ script: masumiValidator() })
    .payToAddress({
      address: walletAddress,
      assets: utxo.assets,
      datum: inlineDatum(outputReferenceTag(lock.txHash, lock.outputIndex)),
      autoMinUtxo: false,
    })
    .addSigner({ keyHash: KeyHash.fromHex(keyHash.hash) })
    .setValidity({ from, to: BigInt(d.now() + VALID_FOR_MS) })
    .build(
      reserve
        ? {
            setCollateral: reserve.collateral,
            coinSelection: (available, required) =>
              largestFirstSelection(available.filter(reserve.isNot), required),
          }
        : { setCollateral: MAX_COLLATERAL },
    );
  const tx = await built.toTransaction();
  const feeLovelace = tx.body.fee.toString();
  const exUnits = (tx.witnessSet.redeemers?.toArray() ?? []).map((r) => ({
    mem: r.exUnits.mem.toString(),
    steps: r.exUnits.steps.toString(),
  }));
  if (dryRun) {
    const report = refundReport(lock, "0".repeat(64), escrow, buyer);
    return { ok: true, alreadyRefunded: false, dryRun, report, feeLovelace, exUnits };
  }
  const signed = await built.sign();
  const txHash = TransactionHash.toHex(await signed.submit()).toLowerCase();
  return {
    ok: true,
    alreadyRefunded: false,
    dryRun,
    report: refundReport(lock, txHash, escrow, buyer),
    feeLovelace,
    exUnits,
    ...(collateralTxHash ? { collateralTxHash } : {}),
  };
}

const sameRef = (a: UTxO.UTxO, b: UTxO.UTxO) =>
  TransactionHash.toHex(a.transactionId) === TransactionHash.toHex(b.transactionId) &&
  a.index === b.index;

/** The largest pure-ADA UTxO of at least 2 tADA, and how much of it to put up (5 tADA at most). */
export function pureAdaReserve(wallet: readonly UTxO.UTxO[]) {
  const reserve = wallet
    .filter((u) => !Assets.hasMultiAsset(u.assets) && u.scriptRef === undefined)
    .sort((a, b) => Number(Assets.lovelaceOf(b.assets) - Assets.lovelaceOf(a.assets)))[0];
  if (!reserve || Assets.lovelaceOf(reserve.assets) < 2_000_000n) return null;
  const lovelace = Assets.lovelaceOf(reserve.assets);
  // All of it up to 5 tADA; above that 5 tADA, unless the return would fall under its minimum.
  const collateral =
    lovelace <= MAX_COLLATERAL
      ? lovelace
      : lovelace - MAX_COLLATERAL >= MIN_RETURN
        ? MAX_COLLATERAL
        : lovelace - MIN_RETURN;
  return {
    utxo: reserve,
    collateral,
    isNot: (u: UTxO.UTxO) => !sameRef(u, reserve),
  };
}

/** 5 tADA to the wallet's own address: a pure-ADA UTxO for collateral. No script, no collateral. */
async function selfTransfer(client: BuyerClient, address: Address.Address): Promise<string> {
  const built = await client
    .newTx()
    .payToAddress({ address, assets: Assets.fromLovelace(MAX_COLLATERAL) })
    .build();
  const signed = await built.sign();
  return TransactionHash.toHex(await signed.submit()).toLowerCase();
}
