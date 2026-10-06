import type { AddressInfo } from "node:net";
import { NETWORK } from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import { toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChainRequest, createFacilitatorApp } from "./app.js";

// The real facilitator scheme; building the signer does not touch the network.
let url = "";
let close = () => {};
const lookups: string[] = [];
const forwarded: ChainRequest[] = [];

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
    lookupTx: async (hash, ttlSlot) => {
      lookups.push(ttlSlot === undefined ? hash : `${hash}@${ttlSlot}`);
      return ttlSlot === undefined ? { found: false } : { found: false, final: true };
    },
    chain: {
      forward: async (request) => {
        forwarded.push(request);
        return { status: 200, contentType: "application/json", body: Buffer.from('{"ok":1}') };
      },
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
    expect(await (await fetch(`${url}/tx/${hash}?ttlSlot=123`)).json()).toEqual({
      found: false,
      final: true,
    });
    expect((await fetch(`${url}/tx/${hash}?ttlSlot=abc`)).status).toBe(400);
    expect(lookups).toEqual([hash, `${hash}@123`]);
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

  it("forwards only the allowlisted Blockfrost paths, bodies untouched", async () => {
    const addr = `addr_test1qp${"q".repeat(50)}`;
    const get = await fetch(`${url}/blockfrost/addresses/${addr}/utxos?page=1&count=100`);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ ok: 1 });
    expect(forwarded.at(-1)).toMatchObject({
      method: "GET",
      path: `/addresses/${addr}/utxos`,
      search: "?page=1&count=100",
    });

    const cbor = Buffer.from("84a40081825820", "hex");
    await fetch(`${url}/blockfrost/tx/submit`, {
      method: "POST",
      headers: { "content-type": "application/cbor" },
      body: cbor,
    });
    expect(forwarded.at(-1)).toMatchObject({ method: "POST", path: "/tx/submit" });
    expect(forwarded.at(-1)?.body?.equals(cbor)).toBe(true);

    const json = '{"cbor":"84a4","additionalUtxoSet":[]}';
    await fetch(`${url}/blockfrost/utils/txs/evaluate/utxos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json,
    });
    expect(forwarded.at(-1)?.body?.toString()).toBe(json);

    const count = forwarded.length;
    for (const path of ["/blockfrost/accounts/stake_test1x", "/blockfrost/epochs/1/parameters"]) {
      expect((await fetch(`${url}${path}`)).status).toBe(404);
    }
    expect((await fetch(`${url}/blockfrost/epochs/latest/parameters?x=1`)).status).toBe(400);
    expect(forwarded.length).toBe(count);
  });
});
