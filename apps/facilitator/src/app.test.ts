import type { AddressInfo } from "node:net";
import { NETWORK } from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import { toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFacilitatorApp } from "./app.js";

// The real facilitator scheme; building the signer does not touch the network.
let url = "";
let close = () => {};
const lookups: string[] = [];

beforeAll(async () => {
  const signer = toFacilitatorCardanoSigner({
    network: NETWORK,
    provider: { blockfrost: { baseUrl: "http://127.0.0.1:9", projectId: "unused" } },
    awaitConfirmation: false,
  });
  const facilitator = new x402Facilitator();
  facilitator.register(NETWORK, new ExactCardanoScheme(signer, { confirmationTimeoutMs: 75_000 }));
  const app = createFacilitatorApp({
    facilitator,
    confirmationTimeoutMs: 75_000,
    lookupTx: async (hash) => {
      lookups.push(hash);
      return { found: false };
    },
    log: createLogger("facilitator-test"),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

describe("facilitator app", () => {
  it("reports health with its confirmation timeout", async () => {
    expect(await (await fetch(`${url}/health`)).json()).toEqual({
      ok: true,
      network: "cardano:preprod",
      confirmationTimeoutMs: 75_000,
    });
  });

  it("supports exact on cardano:preprod with 0 to 20 confirmations", async () => {
    const supported = (await (await fetch(`${url}/supported`)).json()) as {
      kinds: { scheme: string; network: string; extra?: Record<string, unknown> }[];
    };
    const kind = supported.kinds.find((k) => k.network === "cardano:preprod");
    expect(kind?.scheme).toBe("exact");
    expect(kind?.extra?.l1Confirmations).toEqual({ minimum: 0, maximum: 20 });
    expect(kind?.extra?.assetTransferMethods).toContain("masumi");
  });

  it("checks the tx hash before asking Blockfrost", async () => {
    expect((await fetch(`${url}/tx/nothex`)).status).toBe(400);
    const hash = "ab".repeat(32);
    expect(await (await fetch(`${url}/tx/${hash}`)).json()).toEqual({ found: false });
    expect(lookups).toEqual([hash]);
  });

  it("answers 400 to a verify or settle without a payment", async () => {
    for (const path of ["/verify", "/settle"]) {
      const res = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(400);
    }
  });
});
