import { Address, ScriptHash } from "@evolution-sdk/evolution";
import { NETWORK } from "@pekkah/protocol";
import {
  MASUMI_DEFAULT_DEPLOYMENT,
  masumiEscrowAddress,
  masumiEscrowScriptHash,
} from "@x402/cardano";
import { describe, expect, it } from "vitest";
import { masumiValidator } from "./masumi-validator.js";

describe("the copied Masumi validator", () => {
  it("is the script behind the escrow address", () => {
    const hash = ScriptHash.toHex(ScriptHash.fromScript(masumiValidator())).toLowerCase();
    expect(hash).toBe(masumiEscrowScriptHash(MASUMI_DEFAULT_DEPLOYMENT));
    expect(masumiEscrowAddress(NETWORK)).toBe(
      "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g",
    );
    expect(Address.toBech32(Address.fromBech32(masumiEscrowAddress(NETWORK)))).toContain(
      "addr_test1w",
    );
  });
});
