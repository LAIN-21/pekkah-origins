import type { AddressInfo } from "node:net";
import { DEFAULT_ASSET, NETWORK } from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import { toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { bearerGuard, registerSmokeRoute } from "./dev.js";
import { EventBus } from "./events.js";
import { createMarketPayments } from "./payments.js";

const TOKEN = "t".repeat(32);
// Well-formed preprod addresses (bech32 charset); never used on chain.
const SELLER_B = `addr_test1vq${"q".repeat(51)}`;
const SELLER_C = `addr_test1vz${"z".repeat(51)}`;
const log = createLogger("market-test");

// The real facilitator scheme, in process: /supported needs no network.
function inProcessFacilitator(): FacilitatorClient {
  const facilitator = new x402Facilitator();
  facilitator.register(
    NETWORK,
    new ExactCardanoScheme(
      toFacilitatorCardanoSigner({
        network: NETWORK,
        provider: { blockfrost: { baseUrl: "http://127.0.0.1:9", projectId: "unused" } },
        awaitConfirmation: false,
      }),
    ),
  );
  return {
    verify: (p, r) => facilitator.verify(p, r),
    settle: (p, r) => facilitator.settle(p, r),
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
}

const servers: { close: () => void }[] = [];
async function start(devRoutes: boolean): Promise<string> {
  const bus = new EventBus(log);
  const payments = createMarketPayments({ facilitator: inProcessFacilitator() }, bus, log);
  const app = createApp({
    version: "0.1.0",
    sha: "test",
    webDist: null,
    workersOnline: () => 0,
    routes: (app) => {
      if (!devRoutes) return;
      registerSmokeRoute(app, bearerGuard(TOKEN), {
        ...payments,
        sellers: { B: SELLER_B, C: SELLER_C },
        asset: DEFAULT_ASSET,
        l1Confirmations: 0,
        log,
      });
    },
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let url = "";
beforeAll(async () => {
  url = await start(true);
});
afterAll(() => {
  for (const s of servers) s.close();
});

const post = (
  path: string,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
) => fetch(`${url}${path}`, { method: "POST", headers, body: '{"note":"smoke"}' });

describe("POST /api/dev/smoke/:seller", () => {
  it("answers an unpaid request with 402 and the chosen seller as payTo", async () => {
    for (const [seller, payTo] of [
      ["B", SELLER_B],
      ["C", SELLER_C],
    ] as const) {
      const res = await post(`/api/dev/smoke/${seller}`);
      expect(res.status).toBe(402);
      const header = res.headers.get("payment-required");
      expect(header).toBeTruthy();
      const required = decodePaymentRequiredHeader(header ?? "");
      expect(required.accepts).toHaveLength(1);
      expect(required.accepts[0]).toMatchObject({
        scheme: "exact",
        network: "cardano:preprod",
        asset: DEFAULT_ASSET,
        amount: "10000",
        payTo,
        maxTimeoutSeconds: 600,
        extra: { areFeesSponsored: false, confirmationPolicy: { l1Confirmations: 0 } },
      });
      // Core strips the "default" marker from the wire: a missing method means default.
      expect(required.accepts[0]?.extra.assetTransferMethod).toBeUndefined();
    }
  });

  it("refuses requests without the dev token before any payment", async () => {
    const res = await post("/api/dev/smoke/B", {});
    expect(res.status).toBe(401);
    expect(res.headers.get("payment-required")).toBeNull();
    expect((await post("/api/dev/smoke/B", { authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("refuses unknown sellers and other spellings of the path", async () => {
    expect((await post("/api/dev/smoke/D")).status).toBe(404);
    expect((await post("/api/dev/smoke/b")).status).toBe(404);
    expect((await post("/API/dev/smoke/B")).status).toBe(404);
    expect((await post("/api/dev/smoke/B/")).status).toBe(404);
  });

  it("treats an unreadable payment header as unpaid", async () => {
    const res = await post("/api/dev/smoke/B", {
      authorization: `Bearer ${TOKEN}`,
      "payment-signature": "not-a-payment",
    });
    expect(res.status).toBe(402);
  });

  it("does not exist without PEKKAH_DEV_ROUTES", async () => {
    const offUrl = await start(false);
    const res = await fetch(`${offUrl}/api/dev/smoke/B`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});
