import { Address, Assets, Data, KeyHash, TransactionHash, UTxO } from "@evolution-sdk/evolution";
import { NETWORK } from "@pekkah/protocol";
import { addressCredentials, masumiEscrowAddress, parseMasumiLockDatum } from "@x402/cardano";
import { describe, expect, it } from "vitest";
import {
  type ChainOutput,
  MAX_COLLATERAL,
  outputReferenceTag,
  parseLockRef,
  pureAdaReserve,
  refundedIn,
  refundRefusal,
  refundReport,
} from "./refund.js";

// The inline datum of a real lock on preprod (tx a6be16bc…#0, public chain data): FundsLocked.
const LOCK_DATUM = [
  "d8799fd8799fd8799f581c57866dd4917ae0c7dd5775d9ae293463d38b26f0d9bb110f3aa33d2fffd8799fd8799fd879",
  "9f581c48818dac1373cf717c199be6bae14a475e8936cedb21f5c8ef6e912affffffffd87a80d8799fd8799f581c4ebf",
  "110b65aecb2218c3c6461e635f9211b073671a483ae750d7c755ffd8799fd8799fd8799f581cdaf7b595a29bb7e9c4e4",
  "f88e72630e7739e4b09805bde820117cebbaffffffffd87a80582aa4010103272006215820ace3ae5fd197969587df2d",
  "fe1387c017da109da4e5805c795a5d9268499343865f5840845846a2012767616464726573735839004ebf110b65aecb",
  "2218c3c6461e635f9211b073671a483ae750d7c755daf7b595a29bb7e9c4e4f88e72630e7739e4b058409805bde82011",
  "7cebbaa166686173686564f4582063bb25ef6740f3d9eb5860470f6d137ec83ef9257f71ab389cd2f45fc6e2f7d15840",
  "b46a77ec3c9d5bb578765836e22c454403391f3687684def51614fbd60b0a1aac1c188ab0742ede780cabe1a4c13e2f1",
  "65f3a61b0aa6d74ad7ae225d3ceb49d19408ff5820b148d439d3cb8d8adafc3cd1cb377166d261a475c68d00a34ef768",
  "3bbc5d049540401a003d189658203632e82ae498d157e871540f424e8aa11803d41e0d59067fe6621e64b5c2811f401b",
  "000001a11061c0311b000001a1106f7bd11b000001a11081cb511b000001a110941ad10000d87980ff",
].join("");
const TUSDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d";
const LOCK = "a".repeat(64);
const view = parseMasumiLockDatum(LOCK_DATUM);
if (!view) throw new Error("the fixture datum must parse");
const buyer = Address.toBech32(
  new Address.Address({
    networkId: 0,
    paymentCredential: KeyHash.fromHex(view.buyer.payment.hash),
    ...(view.buyer.stake ? { stakingCredential: KeyHash.fromHex(view.buyer.stake.hash) } : {}),
  }),
);
const escrow: ChainOutput = {
  address: masumiEscrowAddress(NETWORK),
  output_index: 0,
  amount: [
    { unit: "lovelace", quantity: "4003990" },
    { unit: TUSDM, quantity: "50000" },
  ],
  inline_datum: LOCK_DATUM,
  consumed_by_tx: null,
};

describe("the lock to refund", () => {
  it("is named <lockTxHash>#<index>", () => {
    expect(parseLockRef(`${LOCK}#0`)).toEqual({ txHash: LOCK, outputIndex: 0 });
    expect(parseLockRef(` ${LOCK.toUpperCase()}#12 `)).toEqual({ txHash: LOCK, outputIndex: 12 });
    expect(parseLockRef(LOCK)).toBeNull();
    expect(parseLockRef(`${LOCK}#x`)).toBeNull();
    expect(parseLockRef("abc#0")).toBeNull();
  });
});

describe("when a refund is allowed", () => {
  const me = addressCredentials(buyer);
  const after = Number(view.submitResultTime) + 1_000;

  it("for the buyer, once the submit-result deadline has passed, with no result", () => {
    expect(refundRefusal(view, me, after)).toBeNull();
  });

  it("not before the deadline", () => {
    expect(refundRefusal(view, me, Number(view.submitResultTime))).toBe(
      "the submit-result deadline has not passed yet",
    );
  });

  it("not for another wallet", () => {
    const seller = view.seller;
    expect(refundRefusal(view, seller, after)).toBe("this wallet is not the escrow's buyer");
  });

  it("not once a result was submitted", () => {
    expect(refundRefusal({ ...view, state: 1n }, me, after)).toMatch(/^the escrow is in state 1/);
    expect(refundRefusal({ ...view, resultHash: "ab".repeat(32) }, me, after)).toBe(
      "the escrow holds a result hash",
    );
  });
});

describe("a refund already on chain", () => {
  it("counts only when the buyer got all of the escrow back", () => {
    const back = { ...escrow, address: buyer, inline_datum: null };
    expect(refundedIn(escrow, [back], buyer)).toBe(true);
    const short = {
      ...back,
      amount: [
        { unit: "lovelace", quantity: "4003990" },
        { unit: TUSDM, quantity: "49999" },
      ],
    };
    expect(refundedIn(escrow, [short], buyer)).toBe(false);
    expect(refundedIn(escrow, [{ ...back, address: masumiEscrowAddress(NETWORK) }], buyer)).toBe(
      false,
    );
  });

  it("is reported with the escrow's token and lovelace", () => {
    expect(refundReport({ txHash: LOCK, outputIndex: 0 }, "b".repeat(64), escrow, buyer)).toEqual({
      lockTxHash: LOCK,
      txHash: "b".repeat(64),
      buyerAddress: buyer,
      amountAtomic: "50000",
      asset: `${TUSDM.slice(0, 56)}.${TUSDM.slice(56)}`,
      collateralReturnLovelace: "4003990",
      explorerUrl: `https://preprod.cardanoscan.io/transaction/${"b".repeat(64)}`,
    });
  });
});

describe("the refund transaction", () => {
  it("tags the buyer's output with the lock's own reference", () => {
    expect(Data.toCBORHex(outputReferenceTag(LOCK, 0))).toBe(`d8799f5820${LOCK}00ff`);
  });

  it("puts up at most 5 tADA of a pure-ADA UTxO as collateral, and none without one", () => {
    const utxo = (i: number, lovelace: bigint, token = false) =>
      new UTxO.UTxO({
        transactionId: TransactionHash.fromHex(i.toString(16).padStart(64, "0")),
        index: 0n,
        address: Address.fromBech32(buyer),
        assets: token
          ? Assets.fromRecord({ lovelace, [TUSDM]: 1_000_000n })
          : Assets.fromLovelace(lovelace),
      });
    expect(pureAdaReserve([utxo(1, 9_925_000_000n, true)])).toBeNull();
    const reserve = pureAdaReserve([utxo(1, 9_925_000_000n, true), utxo(2, 5_000_000n)]);
    expect(reserve?.collateral).toBe(MAX_COLLATERAL);
    expect(pureAdaReserve([utxo(3, 3_000_000n)])?.collateral).toBe(3_000_000n);
    // Just over 5 tADA: the return must stay above its minimum.
    expect(pureAdaReserve([utxo(5, 5_100_000n)])?.collateral).toBe(3_600_000n);
    expect(pureAdaReserve([utxo(4, 1_000_000n)])).toBeNull();
  });
});
