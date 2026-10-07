import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Address, Data } from "@evolution-sdk/evolution";
import { explorerTxUrl, type JobEvent, NETWORK } from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import { masumiEscrowAddress, parseMasumiLockDatum } from "@x402/cardano";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerGuard } from "./dev.js";
import { addressFromCredentials, type ChainTxUtxos, checkRefund } from "./escrow-release.js";
import { EventBus } from "./events.js";
import { ReportedRefunds } from "./reported-refunds.js";
import { submittedDatum } from "./result-submit.js";
import { type ReportedChainEvents, registerAgentEvents } from "./routes.js";
import { LOCK_DATUM, RESULT, TUSDM_UNIT } from "./test-support/escrow.js";

const log = createLogger("agent-events-test");
const ESCROW = masumiEscrowAddress(NETWORK);
const LOCK = "a".repeat(64);
const REFUND = "b".repeat(64);
const OTHER = "c".repeat(64);
const view = parseMasumiLockDatum(LOCK_DATUM);
if (!view) throw new Error("the fixture datum must parse");
const BUYER = Address.toBech32(addressFromCredentials(view.buyer));
const amount = [
  { unit: "lovelace", quantity: "4003990" },
  { unit: TUSDM_UNIT, quantity: "50000" },
];
const out = (o: Partial<ChainTxUtxos["outputs"][number]>): ChainTxUtxos["outputs"][number] => ({
  address: ESCROW,
  output_index: 0,
  amount,
  inline_datum: null,
  consumed_by_tx: null,
  ...o,
});
const chain = (txs: Record<string, ChainTxUtxos["outputs"]>) => async (txHash: string) =>
  txs[txHash] ? { outputs: txs[txHash] } : null;
const refunded = chain({
  [LOCK]: [out({ inline_datum: LOCK_DATUM, consumed_by_tx: REFUND })],
  [REFUND]: [out({ address: BUYER })],
});

describe("checking a reported refund on chain", () => {
  it("accepts a transaction that closed the escrow and gave the buyer all of it", async () => {
    expect(await checkRefund(refunded, { txHash: LOCK, outputIndex: 0 }, REFUND)).toEqual({
      ok: true,
      refund: {
        lockTxHash: LOCK,
        txHash: REFUND,
        buyerAddress: BUYER,
        amountAtomic: "50000",
        asset: `${TUSDM_UNIT.slice(0, 56)}.${TUSDM_UNIT.slice(56)}`,
        collateralReturnLovelace: "4003990",
      },
    });
  });

  it("refuses another transaction, an open escrow, and a short refund", async () => {
    expect(await checkRefund(refunded, { txHash: LOCK }, OTHER)).toEqual({
      ok: false,
      reason: `the escrow was closed by ${REFUND}, not ${OTHER}`,
    });
    const open = chain({ [LOCK]: [out({ inline_datum: LOCK_DATUM })] });
    expect(await checkRefund(open, { txHash: LOCK }, REFUND)).toEqual({
      ok: false,
      reason: "the escrow is still open",
    });
    const short = chain({
      [LOCK]: [out({ inline_datum: LOCK_DATUM, consumed_by_tx: REFUND })],
      [REFUND]: [out({ address: BUYER, amount: [{ unit: "lovelace", quantity: "4003990" }] })],
    });
    expect(await checkRefund(short, { txHash: LOCK }, REFUND)).toEqual({
      ok: false,
      reason: "the buyer did not get all of the escrow back",
    });
  });
});

describe("refunds versus releases", () => {
  it("never takes the spend of an escrow with a result for a refund", async () => {
    const withResult = Data.toCBORHex(
      submittedDatum(Data.fromCBORHex(LOCK_DATUM) as Data.Constr, RESULT, 1n),
    );
    // The lock, its SubmitResult continuation, then a spend that gives the buyer everything.
    const SUBMIT = "d".repeat(64);
    const txs = chain({
      [LOCK]: [out({ inline_datum: LOCK_DATUM, consumed_by_tx: SUBMIT })],
      [SUBMIT]: [out({ inline_datum: withResult, consumed_by_tx: REFUND })],
      [REFUND]: [out({ address: BUYER })],
    });
    expect(await checkRefund(txs, { txHash: LOCK }, REFUND)).toEqual({
      ok: false,
      reason: "the escrow held a result: its spend is a release, not a refund",
    });
  });
});

describe("the refunds the market has recorded", () => {
  it("are kept across a restart, so a repeated report emits nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pekkah-refunds-"));
    try {
      const first = new ReportedRefunds(dir, log);
      expect(first.has(LOCK, REFUND)).toBe(false);
      first.add(LOCK, REFUND);
      const restarted = new ReportedRefunds(dir, log);
      expect(restarted.has(LOCK, REFUND)).toBe(true);
      expect(restarted.has(LOCK, OTHER)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("start empty without a data directory, or from an unreadable file", () => {
    expect(new ReportedRefunds(null, log).has(LOCK, REFUND)).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "pekkah-refunds-"));
    try {
      writeFileSync(join(dir, "refunds.json"), "{ not json");
      expect(new ReportedRefunds(dir, log).has(LOCK, REFUND)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /api/agent-events with a refund", () => {
  const TOKEN = "t".repeat(32);
  let url = "";
  let bus: EventBus;
  let close = () => {};
  const event = (runId: string) => ({
    source: "chain" as const,
    type: "escrow.refunded" as const,
    runId,
    data: {
      lockTxHash: LOCK,
      txHash: REFUND,
      buyerAddress: BUYER,
      amountAtomic: "50000",
      asset: `${TUSDM_UNIT.slice(0, 56)}.${TUSDM_UNIT.slice(56)}`,
      collateralReturnLovelace: "4003990",
      explorerUrl: explorerTxUrl(REFUND),
    },
  });
  const reported: ReportedChainEvents = {
    refunded: async ({ txHash }) =>
      txHash === REFUND
        ? { ok: true, event: event("01RUNLOCK") }
        : { ok: false, reason: "the escrow was closed by another transaction" },
  };

  beforeAll(async () => {
    bus = new EventBus(log);
    const app = express();
    registerAgentEvents(app, bearerGuard(TOKEN), bus, reported);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent-events`;
    close = () => server.close();
  });
  afterAll(() => close());

  const post = (events: unknown[]) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ events }),
    });
  const report = (txHash: string) => ({
    type: "escrow.refunded",
    data: { ...event("x").data, txHash },
  });

  it("emits a checked refund as a chain event, in the lock's run", async () => {
    const res = await post([report(REFUND)]);
    expect(res.status).toBe(202);
    const last = bus.latest().at(-1) as JobEvent;
    expect(last).toMatchObject({ type: "escrow.refunded", source: "chain", runId: "01RUNLOCK" });
  });

  it("refuses a refund the chain does not show, and says why", async () => {
    const before = bus.latest().length;
    const res = await post([report(OTHER)]);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      accepted: 0,
      rejected: 1,
      reasons: ["the escrow was closed by another transaction"],
    });
    expect(bus.latest().length).toBe(before);
  });

  it("still takes my agent's own events as agent events", async () => {
    const res = await post([{ type: "run.failed", data: { reason: "x" }, runId: "01RUNX" }]);
    expect(res.status).toBe(202);
    expect(bus.latest().at(-1)).toMatchObject({ type: "run.failed", source: "agent" });
  });

  it("never lets an agent post another chain event", async () => {
    const res = await post([{ type: "escrow.released", data: {} }]);
    expect(res.status).toBe(400);
  });
});
