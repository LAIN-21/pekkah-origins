import {
  Address,
  Assets,
  Data,
  InlineDatum,
  TransactionHash,
  UTxO,
} from "@evolution-sdk/evolution";
import { NETWORK } from "@pekkah/protocol";
import { addressCredentials, masumiEscrowAddress, parseMasumiLockDatum } from "@x402/cardano";
import { describe, expect, it } from "vitest";
import {
  addressFromCredentials,
  buildRelease,
  type ChainTxUtxos,
  locateEscrow,
  outputReferenceTag,
  releaseOf,
} from "./escrow-release.js";
import { type SellerClient, submittedDatum } from "./result-submit.js";
import { LOCK_DATUM, RESULT, SELLER_A, TUSDM_UNIT } from "./test-support/escrow.js";

const ESCROW = masumiEscrowAddress(NETWORK);
const LOCK_TX = "a".repeat(64);
const SUBMIT_TX = "b".repeat(64);
const RELEASE_TX = "c".repeat(64);
const locked = Data.fromCBORHex(LOCK_DATUM) as Data.Constr;
const submitted = submittedDatum(locked, RESULT, 1_791_280_000_000n);
const view = parseMasumiLockDatum(submitted);
if (!view) throw new Error("the fixture datum must parse");
const BUYER = Address.toBech32(addressFromCredentials(view.buyer));
const escrowAmount = [
  { unit: "lovelace", quantity: "4003990" },
  { unit: TUSDM_UNIT, quantity: "50000" },
];

/** A stand-in for the chain passthrough's GET /txs/:hash/utxos. */
function chain(txs: Record<string, ChainTxUtxos["outputs"]>) {
  return async (txHash: string) => (txs[txHash] ? { outputs: txs[txHash] } : null);
}
const output = (o: Partial<ChainTxUtxos["outputs"][number]>): ChainTxUtxos["outputs"][number] => ({
  address: ESCROW,
  output_index: 0,
  amount: escrowAmount,
  inline_datum: null,
  consumed_by_tx: null,
  ...o,
});
const lockOutput = (consumedBy: string | null) =>
  output({ inline_datum: LOCK_DATUM, consumed_by_tx: consumedBy });
const submitOutput = (consumedBy: string | null) =>
  output({ inline_datum: Data.toCBORHex(submitted), consumed_by_tx: consumedBy });

describe("the release's outputs", () => {
  it("tags them with the spent UTxO's reference, as a Plutus V3 OutputReference", () => {
    const tag = outputReferenceTag(SUBMIT_TX, 0);
    expect(Data.toCBORHex(tag)).toBe(`d8799f5820${SUBMIT_TX}00ff`);
  });

  it("rebuilds the datum's addresses exactly, stake credential included", () => {
    const rebuilt = Address.toBech32(addressFromCredentials(addressCredentials(SELLER_A)));
    expect(rebuilt).toBe(SELLER_A);
    expect(BUYER).toMatch(/^addr_test1q/);
  });
});

describe("finding where a lock's escrow sits now", () => {
  it("is the lock's own output while nobody has spent it", async () => {
    const txs = chain({ [LOCK_TX]: [lockOutput(null)] });
    expect(await locateEscrow(txs, LOCK_TX)).toEqual({
      kind: "open",
      txHash: LOCK_TX,
      outputIndex: 0,
    });
  });

  it("starts from the lock's own escrow output when it is named, and fails closed when not", async () => {
    // Two escrow outputs in one lock transaction: only the index says which is this lock.
    const other = { ...submitOutput(null), output_index: 0 };
    const mine = { ...lockOutput(null), output_index: 1 };
    const txs = chain({ [LOCK_TX]: [other, mine] });
    expect(await locateEscrow(txs, LOCK_TX, 1)).toEqual({
      kind: "open",
      txHash: LOCK_TX,
      outputIndex: 1,
    });
    expect(await locateEscrow(txs, LOCK_TX)).toEqual({
      kind: "unknown",
      reason: "the lock transaction has 2 escrow outputs; name the output index",
    });
    const plain = chain({ [LOCK_TX]: [output({ address: SELLER_A }), mine] });
    expect(await locateEscrow(plain, LOCK_TX, 0)).toEqual({
      kind: "unknown",
      reason: "output 0 of the lock is not an escrow",
    });
  });

  it("follows SubmitResult's continuing output, matching the reference signature", async () => {
    const other = output({ output_index: 0, inline_datum: null });
    const txs = chain({
      [LOCK_TX]: [
        output({ address: SELLER_A, inline_datum: null }),
        { ...lockOutput(SUBMIT_TX), output_index: 1 },
      ],
      [SUBMIT_TX]: [other, { ...submitOutput(null), output_index: 2 }],
    });
    expect(await locateEscrow(txs, LOCK_TX)).toEqual({
      kind: "open",
      txHash: SUBMIT_TX,
      outputIndex: 2,
    });
  });

  it("is closed once a spend leaves no escrow output", async () => {
    const txs = chain({
      [LOCK_TX]: [lockOutput(SUBMIT_TX)],
      [SUBMIT_TX]: [submitOutput(RELEASE_TX)],
      [RELEASE_TX]: [output({ address: BUYER })],
    });
    expect(await locateEscrow(txs, LOCK_TX)).toMatchObject({
      kind: "closed",
      spentBy: RELEASE_TX,
    });
  });

  it("is unknown while the lock is not on chain", async () => {
    expect(await locateEscrow(chain({}), LOCK_TX)).toMatchObject({ kind: "unknown" });
  });
});

describe("telling a release from a refund, on chain", () => {
  const closed = { kind: "closed" as const, spentBy: RELEASE_TX, last: submitOutput(RELEASE_TX) };

  it("is a release when Seller A got the token and the buyer the collateral", async () => {
    const txs = chain({
      [RELEASE_TX]: [
        output({ address: BUYER, amount: [{ unit: "lovelace", quantity: "4003990" }] }),
        output({
          address: SELLER_A,
          output_index: 1,
          amount: [
            { unit: "lovelace", quantity: "1189560" },
            { unit: TUSDM_UNIT, quantity: "50000" },
          ],
        }),
      ],
    });
    expect(await releaseOf(txs, closed, SELLER_A)).toEqual({
      buyerAddress: BUYER,
      sellerAddress: SELLER_A,
      asset: `${TUSDM_UNIT.slice(0, 56)}.${TUSDM_UNIT.slice(56)}`,
      amountAtomic: "50000",
      buyerLovelace: "4003990",
      collateralReturnLovelace: view.collateralReturnLovelace.toString(),
      unlockTime: Number(view.unlockTime),
    });
  });

  it("is not a release when the buyer got less than all of the escrow's lovelace", async () => {
    const richer = {
      ...closed,
      last: submitOutput(RELEASE_TX),
    };
    richer.last.amount = [
      { unit: "lovelace", quantity: "9000000" },
      { unit: TUSDM_UNIT, quantity: "50000" },
    ];
    const txs = chain({
      [RELEASE_TX]: [
        output({ address: BUYER, amount: [{ unit: "lovelace", quantity: "4003990" }] }),
        output({
          address: SELLER_A,
          output_index: 1,
          amount: [
            { unit: "lovelace", quantity: "6189560" },
            { unit: TUSDM_UNIT, quantity: "50000" },
          ],
        }),
      ],
    });
    expect(await releaseOf(txs, richer, SELLER_A)).toBeNull();
  });

  it("is not a release when everything went back to the buyer", async () => {
    const txs = chain({ [RELEASE_TX]: [output({ address: BUYER })] });
    expect(await releaseOf(txs, closed, SELLER_A)).toBeNull();
  });
});

describe("building a release refuses before it touches the wallet", () => {
  const utxo = (datum: Data.Data, address = ESCROW) =>
    new UTxO.UTxO({
      transactionId: TransactionHash.fromHex(SUBMIT_TX),
      index: 0n,
      address: Address.fromBech32(address),
      assets: Assets.fromRecord({ lovelace: 4_003_990n, [TUSDM_UNIT]: 50_000n }),
      datumOption: new InlineDatum.InlineDatum({ data: datum }),
    });
  // Never reached: each refusal comes before the first wallet read.
  const client = {} as SellerClient;
  const after = { sellerAddress: SELLER_A, now: () => Number(view.unlockTime) + 5_000 };

  it("a lock still in FundsLocked: no result was submitted", async () => {
    expect(await buildRelease(client, utxo(locked), after)).toMatchObject({
      ok: false,
      retry: false,
      reason: "the escrow is in state 0, not ResultSubmitted",
    });
  });

  it("before the unlock time, to try again later", async () => {
    const before = { ...after, now: () => Number(view.unlockTime) };
    expect(await buildRelease(client, utxo(submitted), before)).toMatchObject({
      ok: false,
      retry: true,
      reason: "the escrow is not unlocked yet",
    });
  });

  it("an escrow whose seller is not Seller A", async () => {
    const other = { ...after, sellerAddress: BUYER };
    expect(await buildRelease(client, utxo(submitted), other)).toMatchObject({
      ok: false,
      retry: false,
      reason: "the escrow's seller is not Seller A",
    });
  });

  it("an output that is not at the escrow address", async () => {
    expect(await buildRelease(client, utxo(submitted, SELLER_A), after)).toMatchObject({
      ok: false,
      reason: "the output is not at the Masumi escrow address",
    });
  });
});
