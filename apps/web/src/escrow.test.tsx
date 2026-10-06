import { MASUMI_LOCK_LABEL } from "@pekkah/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PaymentPanel, Timeline } from "./components/PaymentPanel";
import { ReceiptPanel } from "./components/ResultPanel";
import { describeEvent } from "./describe";
import { fixtureRunLog } from "./dev/fixture";
import { deriveRun, isEscrow, stepStates } from "./run";

const name = (id: string) => `Worker ${id}`;
/**
 * PLAN 4.8: a Masumi lock is "locked in escrow". Never say the worker was paid or that
 * funds were released. ("Release, refund and dispute tooling is my next step" is the
 * mandated label, so "release" alone is fine.)
 */
const FORBIDDEN = /\bpaid\b|\breleased\b/i;

describe("escrow runs (PR-08m)", () => {
  for (const scenario of ["gpu-image-escrow", "fractal-escrow"] as const) {
    const log = fixtureRunLog(scenario);
    const run = deriveRun(log.runId, log.events);
    const attempt = run.attempts[0];

    it(`${scenario}: the attempt is an escrow lock with worker A as the seller`, () => {
      expect(attempt && isEscrow(attempt)).toBe(true);
      expect(attempt?.workerId).toBe("A");
      // The selected worker is the seller (PLAN 4.9 point 4).
      const chosen = run.decisions[0]?.data.chosen;
      expect(chosen?.workerId).toBe("A");
      expect(attempt?.escrow?.data.sellerAddress).toBe(chosen?.payTo);
      expect(attempt?.receipt?.data.receipt.transferMethod).toBe("masumi");
      expect(attempt && stepStates(attempt).settled).toBe("done");
    });

    it(`${scenario}: the receipt and escrow card say "locked in escrow", never paid or released`, () => {
      const receipt = renderToStaticMarkup(<ReceiptPanel run={run} name={name} />);
      expect(receipt).toContain("Locked in escrow · seller: Worker A");
      expect(receipt).toContain(MASUMI_LOCK_LABEL);
      for (const label of ["Pay by", "Result due", "Unlock", "Dispute unlock", "Request hash"]) {
        expect(receipt).toContain(label);
      }
      expect(receipt).not.toMatch(FORBIDDEN);
      expect(receipt).not.toContain("Paid to");
    });

    it(`${scenario}: the payment steps end in "locked in escrow", not "settled"`, () => {
      const payment = renderToStaticMarkup(<PaymentPanel run={run} name={name} />);
      expect(payment).toContain("locked in escrow");
      expect(payment).not.toContain(">settled<");
      expect(payment).not.toMatch(FORBIDDEN);
    });

    it(`${scenario}: no timeline line about the lock says paid or released`, () => {
      const lockEvents = run.events.filter((e) =>
        [
          "payment.required",
          "payment.settling",
          "payment.settled",
          "receipt.issued",
          "escrow.locked",
        ].includes(e.type),
      );
      expect(lockEvents.map((e) => e.type)).toContain("escrow.locked");
      for (const e of lockEvents) {
        const line = describeEvent(e, name);
        expect(`${line.title} ${line.detail ?? ""}`).not.toMatch(FORBIDDEN);
      }
      expect(renderToStaticMarkup(<Timeline run={run} name={name} />)).toContain(
        "Locked in escrow on Cardano preprod",
      );
    });
  }

  it("fixture locks: deadlines follow the lock's time, and each request has its own hash", () => {
    const locks = (["gpu-image-escrow", "fractal-escrow"] as const).map((scenario) => {
      const log = fixtureRunLog(scenario, 7);
      const lock = log.events.find((e) => e.type === "escrow.locked");
      if (lock?.type !== "escrow.locked") throw new Error("no lock");
      return lock;
    });
    for (const lock of locks) {
      expect(Number(lock.data.payByTime) - Date.parse(lock.ts)).toBe(600_000);
    }
    expect(locks[0]?.data.inputHash).not.toBe(locks[1]?.data.inputHash);
  });

  it("a default payment still says who was paid", () => {
    const log = fixtureRunLog("gpu-image");
    const run = deriveRun(log.runId, log.events);
    expect(renderToStaticMarkup(<PaymentPanel run={run} name={name} />)).toContain(
      "Paid to Worker A, the worker that ran the job",
    );
  });
});
