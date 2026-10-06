import type { AddressInfo } from "node:net";
import { explorerTxUrl } from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerGuard } from "./dev.js";
import type { EscrowReleaser, ReleaseOutcome } from "./escrow-release.js";
import { registerEscrowReleaseRoute } from "./escrow-release-route.js";
import { EventBus } from "./events.js";
import { ReleaseScheduler } from "./release-scheduler.js";
import { RunStore } from "./runs.js";
import { SELLER_A } from "./test-support/escrow.js";

const log = createLogger("release-route-test");
const TOKEN = "d".repeat(32);
const LOCK = "a".repeat(64);
const RELEASED_LOCK = "f".repeat(64);
const RELEASE = "c".repeat(64);
const plan = {
  buyerAddress: `addr_test1q${"p".repeat(97)}`,
  sellerAddress: SELLER_A,
  asset: "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d",
  amountAtomic: "50000",
  buyerLovelace: "4003990",
  collateralReturnLovelace: "4003990",
  unlockTime: 1,
};
const calls: { lockTxHash: string; dryRun: boolean; outputIndex?: number }[] = [];
let next: ReleaseOutcome = {
  ok: true,
  dryRun: false,
  txHash: RELEASE,
  plan,
  feeLovelace: "668748",
  exUnits: [{ mem: "452954", steps: "158919028" }],
};
let url = "";
const cleanup: (() => void)[] = [];

beforeAll(async () => {
  const bus = new EventBus(log);
  const runs = new RunStore(bus, null, log);
  // A run whose lock was already released, as the bus would have recorded it.
  bus.emit({
    source: "chain",
    type: "escrow.locked",
    runId: "01RUNDONE",
    data: {
      txHash: RELEASED_LOCK,
      escrowAddress: `addr_test1w${"z".repeat(52)}`,
      sellerAddress: SELLER_A,
      amountAtomic: "50000",
      asset: plan.asset,
      collateralLovelace: "4003990",
      inputHash: "e".repeat(64),
      payByTime: "1",
      submitResultTime: "2",
      unlockTime: "3",
      externalDisputeUnlockTime: "4",
      explorerUrl: explorerTxUrl(RELEASED_LOCK),
    },
  });
  bus.emit({
    source: "chain",
    type: "escrow.released",
    runId: "01RUNDONE",
    data: {
      lockTxHash: RELEASED_LOCK,
      txHash: RELEASE,
      sellerAddress: SELLER_A,
      buyerAddress: plan.buyerAddress,
      amountAtomic: "50000",
      asset: plan.asset,
      collateralReturnLovelace: "4003990",
      explorerUrl: explorerTxUrl(RELEASE),
    },
  });
  const release: EscrowReleaser = async (lockTxHash, options = {}) => {
    calls.push({
      lockTxHash,
      dryRun: options.dryRun === true,
      ...(options.outputIndex !== undefined ? { outputIndex: options.outputIndex } : {}),
    });
    return options.dryRun && next.ok ? { ...next, dryRun: true, txHash: "" } : next;
  };
  const releases = new ReleaseScheduler({
    release: ({ lockTxHash, outputIndex }) =>
      release(lockTxHash, outputIndex !== undefined ? { outputIndex } : {}),
    txFound: async () => false,
    emit: (event) => void bus.emit(event),
    log,
    polls: 0,
  });
  const app = express();
  registerEscrowReleaseRoute(app, bearerGuard(TOKEN), { releases, release, runs, log });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/escrow/release`;
  cleanup.push(() => {
    releases.close();
    server.close();
  });
});
afterAll(() => {
  for (const fn of cleanup) fn();
});

const post = (body: unknown, token: string | null = TOKEN) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

describe("POST /api/escrow/release", () => {
  it("needs DEMO_TOKEN and a lock tx hash", async () => {
    expect((await post({ lockTxHash: LOCK }, null)).status).toBe(401);
    expect((await post({ lockTxHash: LOCK }, "x".repeat(32))).status).toBe(401);
    expect((await post({ lockTxHash: "nope" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("builds and evaluates a dry run, signing nothing", async () => {
    const res = await post({ lockTxHash: LOCK, dryRun: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, dryRun: true, feeLovelace: "668748" });
    expect(calls.at(-1)).toEqual({ lockTxHash: LOCK, dryRun: true });
    await post({ lockTxHash: LOCK, outputIndex: 3, dryRun: true });
    expect(calls.at(-1)).toEqual({ lockTxHash: LOCK, dryRun: true, outputIndex: 3 });
    expect((await post({ lockTxHash: LOCK, outputIndex: -1 })).status).toBe(400);
  });

  it("answers a lock the run log already shows released, without a second release", async () => {
    const before = calls.length;
    const res = await post({ lockTxHash: RELEASED_LOCK });
    expect(await res.json()).toEqual({ released: true, txHash: RELEASE, runId: "01RUNDONE" });
    expect(calls.length).toBe(before);
  });

  it("releases a lock and answers with the transaction", async () => {
    const res = await post({ lockTxHash: LOCK });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      txHash: RELEASE,
      explorerUrl: explorerTxUrl(RELEASE),
      feeLovelace: "668748",
    });
    expect(calls.at(-1)).toEqual({ lockTxHash: LOCK, dryRun: false });
  });

  it("explains a refusal", async () => {
    next = { ok: false, reason: "the escrow is not unlocked yet", retry: true };
    const other = "9".repeat(64);
    const res = await post({ lockTxHash: other });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "not_released",
      reason: "the escrow is not unlocked yet",
    });
  });
});
