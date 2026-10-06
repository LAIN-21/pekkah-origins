import { Data } from "@evolution-sdk/evolution";
import { describe, expect, it } from "vitest";
import { submittedDatum } from "./result-submit.js";

// The inline datum of a real lock on preprod (tx a6be16bc…#0, public chain data).
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
const RESULT = "454524db2dee12985a879389e61ae2ca3dc61e5b49877e0967bbc0a8b806fef9";

describe("the datum after SubmitResult", () => {
  it("sets the result hash, state and cooldowns, and keeps every other field", () => {
    const locked = Data.fromCBORHex(LOCK_DATUM) as Data.Constr;
    const next = submittedDatum(locked, RESULT, 1_791_280_000_000n);
    expect(next.index).toBe(0n);
    expect(next.fields).toHaveLength(19);
    const changed = [11, 16, 17, 18];
    locked.fields.forEach((field, i) => {
      if (changed.includes(i)) return;
      expect(Data.toCBORHex(next.fields[i] as Data.Data), `field ${i}`).toBe(Data.toCBORHex(field));
    });
    expect(Buffer.from(next.fields[11] as Uint8Array).toString("hex")).toBe(RESULT);
    expect(next.fields[16]).toBe(1_791_280_000_000n);
    expect(next.fields[17]).toBe(0n);
    expect(next.fields[18]).toMatchObject({ index: 1n, fields: [] });
  });

  it("refuses a datum that is not FundsLocked, or a result hash that is not 32 bytes", () => {
    const locked = Data.fromCBORHex(LOCK_DATUM) as Data.Constr;
    const submitted = submittedDatum(locked, RESULT, 1n);
    expect(() => submittedDatum(submitted, RESULT, 1n)).toThrow("not in FundsLocked");
    expect(() => submittedDatum(locked, "abc", 1n)).toThrow("32 bytes");
    expect(() => submittedDatum(Data.constr(0n, []), RESULT, 1n)).toThrow("vested_pay V2");
  });
});
