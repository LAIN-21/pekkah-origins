import { Data } from "@evolution-sdk/evolution";
import type { Logger } from "@pekkah/runtime";
import { describe, expect, it } from "vitest";
import { throwawayMnemonic } from "../../../packages/runtime/src/test-support/mnemonic.js";
import { submittedDatum, tryCreateResultSubmitter } from "./result-submit.js";

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

describe("setting up the submitter", () => {
  const options = (sellerAddress: string) => {
    const errors: string[] = [];
    const log = { error: (m: string) => void errors.push(m) } as unknown as Logger;
    const o = {
      chainUrl: "http://127.0.0.1:9/blockfrost",
      sellerMnemonic: throwawayMnemonic(),
      sellerAddress,
      log,
    };
    return { o, errors };
  };

  it("disables only result submission when it cannot be set up", () => {
    const { o, errors } = options("addr_test1notanaddress");
    expect(tryCreateResultSubmitter(o)).toBeNull();
    expect(errors[0]).toMatch(/^Escrow result submission disabled: /);
    expect(errors[0]).not.toContain(o.sellerMnemonic.split(" ")[0]);
  });

  it("refuses a script address as the seller", () => {
    const { o, errors } = options(
      "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g",
    );
    expect(tryCreateResultSubmitter(o)).toBeNull();
    expect(errors[0]).toContain("must be a key address");
  });

  it("builds offline from a valid seller key address", () => {
    const { o } = options(
      // Seller A's public payout address on preprod (README): a key address.
      "addr_test1qp8t7ygtvkhvkgscc0ryv8nrt7fprvrnvudyswh82rtuw4w6776etg5mkl5ufe8c3eexxrnh88jtpxq9hh5zqytuawaqxfywga",
    );
    expect(typeof tryCreateResultSubmitter(o)).toBe("function");
  });
});
