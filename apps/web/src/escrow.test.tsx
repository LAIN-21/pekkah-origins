import { MASUMI_LOCK_LABEL, MASUMI_RELEASED_LABEL } from "@pekkah/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionPanel, RequestCard } from "./components/DecisionPanel";
import { countdown, EscrowPanel } from "./components/EscrowCard";
import { MarketPanel } from "./components/MarketPanel";
import { PaymentPanel } from "./components/PaymentPanel";
import { ReceiptPanel } from "./components/ResultPanel";
import { logRows, RunLog } from "./components/RunLog";
import { describeEvent } from "./describe";
import { fixtureRunLog } from "./dev/fixture";
import { deriveRun, isEscrow, stepStates } from "./run";

const name = (id: string) => `Worker ${id}`;
/**
 * Rule 4: a Masumi lock is "locked in escrow" until an escrow.released event exists for it.
 * Before that, nothing says the worker was paid or that funds were released. ("Release to
 * Worker A, after the unlock" names a step to come, so "release" alone is fine.)
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
      expect(receipt).not.toMatch(FORBIDDEN);
      expect(receipt).not.toContain("Paid to");
      const card = renderToStaticMarkup(<EscrowPanel run={run} name={name} />);
      expect(card).toContain(MASUMI_LOCK_LABEL);
      for (const label of ["Pay by", "Result due", "Unlock", "Dispute unlock", "Request hash"]) {
        expect(card).toContain(label);
      }
      expect(card).toContain("Release to Worker A");
      // Dispute isn't built: the card always names it as next, once.
      expect(card.match(/dispute[^<]*next step/gi)).toHaveLength(1);
      expect(card).not.toMatch(FORBIDDEN);
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
      expect(renderToStaticMarkup(<RunLog run={run} name={name} />)).toContain(
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

  it("fixture locks: PR-16's deadlines, the unlock about 31.5 minutes after the 402", () => {
    const lock = fixtureRunLog("gpu-image-escrow").events.find((e) => e.type === "escrow.locked");
    if (lock?.type !== "escrow.locked") throw new Error("no lock");
    const payBy = Number(lock.data.payByTime);
    expect(Number(lock.data.submitResultTime) - payBy).toBe(6 * 60_000);
    expect(Number(lock.data.unlockTime) - payBy).toBe(21.5 * 60_000);
    expect(Number(lock.data.externalDisputeUnlockTime) - payBy).toBe(37 * 60_000);
  });

  it("a default payment still says who was paid", () => {
    const log = fixtureRunLog("gpu-image");
    const run = deriveRun(log.runId, log.events);
    expect(renderToStaticMarkup(<PaymentPanel run={run} name={name} />)).toContain(
      "Paid to Worker A, the worker that ran the job",
    );
  });
});

describe("Claude's escrow buy through the MCP (PR-14, PR-15)", () => {
  const log = fixtureRunLog("mcp");
  const run = deriveRun(log.runId, log.events);

  it("the header comes from the request and the client, not a scenario", () => {
    const html = renderToStaticMarkup(<RequestCard run={run} />);
    expect(html).toContain("Claude via MCP");
    expect(html).toContain("An image: “a poster of a lighthouse at dusk”");
    expect(html).toContain("budget $0.03");
  });

  it("my agent's over-budget decision reads as its statement, with its reason", () => {
    const html = renderToStaticMarkup(<DecisionPanel run={run} name={name} />);
    expect(html).toContain("My agent says I approved $0.05 (budget $0.03).");
    expect(html).toContain("Only worker A has a GPU.");
    const decision = run.events.find((e) => e.type === "agent.decision");
    if (!decision) throw new Error("no decision");
    expect(describeEvent(decision, name).detail).toContain(
      "My agent says I approved $0.05 (budget $0.03).",
    );
  });

  it("the market's PNG check is its own row in the log", () => {
    const rows = logRows(run.events, name);
    const delivered = rows.findIndex((r) => r.line.title === "Worker A delivered the result");
    expect(rows[delivered + 1]?.line.title).toBe("The market checked the result: a PNG, 1024×1024");
    expect(rows[delivered + 1]?.source).toBe("Market");
  });

  it("the result hash matches the delivered result, and the card counts down to the unlock", () => {
    const a = run.attempts[0];
    expect(a?.resultSubmitted?.data.resultHash).toBe(a?.completed?.data.sha256);
    const card = renderToStaticMarkup(<EscrowPanel run={run} name={name} />);
    expect(card).toContain("Result hash submitted");
    expect(card).toContain("It matches the delivered result.");
    expect(card).toContain("Unlocks at");
    expect(card).toMatch(/in \d+:\d\d/);
    expect(card).not.toMatch(FORBIDDEN);
  });

  it("says released to worker A only once escrow.released exists, with the collateral back", () => {
    const done = fixtureRunLog("mcp-released", 40);
    const released = deriveRun(done.runId, done.events);
    const card = renderToStaticMarkup(<EscrowPanel run={released} name={name} />);
    expect(card).toContain("Released to Worker A");
    expect(card).toContain("of collateral came back");
    expect(card).toContain(MASUMI_RELEASED_LABEL.replaceAll("'", "&#x27;"));
    expect(card.match(/dispute[^<]*next step/gi)).toHaveLength(1);
    expect(card).not.toContain(MASUMI_LOCK_LABEL);
    expect(renderToStaticMarkup(<ReceiptPanel run={released} name={name} />)).toContain(
      "Released to Worker A after the unlock",
    );
    const e = done.events.find((x) => x.type === "escrow.released");
    if (!e) throw new Error("no release");
    expect(describeEvent(e, name, () => "Worker A").title).toBe("Released to Worker A");
  });

  it("counts down in minutes and seconds, then hours", () => {
    expect(countdown(65_000, 0)).toBe("in 1:05");
    expect(countdown(3_725_000, 0)).toBe("in 1:02:05");
    expect(countdown(0, 5_000)).toBe("in 0:00");
  });
});

describe("the market's panel (PR-15)", () => {
  const worker = {
    workerId: "A",
    name: "Worker A",
    payTo: `addr_test1q${"pzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(2).slice(0, 57)}`,
    hardware: { cpuModel: "Xeon", vcpus: 8, memGb: 32 },
    prices: [{ workload: "fractal" as const, usd: 0.05, atomic: "50000" }],
    status: "online" as const,
    calibration: {},
    warm: ["fractal" as const],
    lastSeenAt: new Date().toISOString(),
    selling: true,
    escrowSeller: true,
  };

  it("labels hardware as reported and lists probation workers apart, by display id", () => {
    const html = renderToStaticMarkup(
      <MarketPanel
        workers={[
          worker,
          {
            ...worker,
            workerId: "joining-3f9a1c",
            name: "my-cool-rig",
            selling: false,
            escrowSeller: false,
          },
        ]}
      />,
    );
    expect(html).toContain("Reported by the machine");
    expect(html).toContain("sells through escrow");
    expect(html).toContain("Joining the network");
    expect(html).toContain("joining-3f9a1c");
    expect(html).not.toContain("my-cool-rig");
  });
});
