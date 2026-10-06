import { Data } from "@evolution-sdk/evolution";
import type { Logger } from "@pekkah/runtime";
import { describe, expect, it } from "vitest";
import { throwawayMnemonic } from "../../../packages/runtime/src/test-support/mnemonic.js";
import {
  createResultSubmitter,
  createSellerChain,
  submittedDatum,
  tryCreateSellerChain,
} from "./result-submit.js";
import { LOCK_DATUM, RESULT } from "./test-support/escrow.js";

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

describe("setting up Seller A's chain access", () => {
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
  // Seller A's public payout address on preprod (README): a key address.
  const SELLER_A =
    "addr_test1qp8t7ygtvkhvkgscc0ryv8nrt7fprvrnvudyswh82rtuw4w6776etg5mkl5ufe8c3eexxrnh88jtpxq9hh5zqytuawaqxfywga";

  it("disables only result submission and release when it cannot be set up", () => {
    const { o, errors } = options("addr_test1notanaddress");
    expect(tryCreateSellerChain(o)).toBeNull();
    expect(errors[0]).toMatch(/^Escrow result submission and release disabled: /);
    expect(errors[0]).not.toContain(o.sellerMnemonic.split(" ")[0]);
  });

  it("refuses a script address as the seller", () => {
    const { o, errors } = options(
      "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g",
    );
    expect(tryCreateSellerChain(o)).toBeNull();
    expect(errors[0]).toContain("must be a key address");
  });

  it("builds offline from a valid seller key address", () => {
    const { o } = options(SELLER_A);
    const chain = tryCreateSellerChain(o);
    expect(chain?.sellerAddress).toBe(SELLER_A);
    expect(typeof (chain && createResultSubmitter({ chain }))).toBe("function");
  });

  it("runs seller transactions one at a time, whatever the previous one did", async () => {
    const { o } = options(SELLER_A);
    const chain = createSellerChain(o);
    const order: string[] = [];
    const task =
      (name: string, ms: number, fail = false) =>
      async () => {
        order.push(`${name} start`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`${name} end`);
        if (fail) throw new Error(name);
        return name;
      };
    const a = chain.enqueue(task("a", 30, true));
    const b = chain.enqueue(task("b", 1));
    await expect(a).rejects.toThrow("a");
    await expect(b).resolves.toBe("b");
    expect(order).toEqual(["a start", "a end", "b start", "b end"]);
  });
});
