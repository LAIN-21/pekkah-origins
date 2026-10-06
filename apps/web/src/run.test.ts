import { JobEvent } from "@pekkah/protocol";
import { describe, expect, it } from "vitest";
import { fixtureRunLog } from "./dev/fixture";
import { deriveRun, isEscrow, latestBalance, runIds, stepStates } from "./run";

describe("deriveRun", () => {
  it("follows a paid gpu-image run from 402 to receipt", () => {
    const log = fixtureRunLog("gpu-image");
    const run = deriveRun(log.runId, log.events);
    expect(run.scenario).toBe("gpu-image");
    expect(run.status).toBe("completed");
    expect(run.quotes).toHaveLength(1);
    expect(run.decisions[0]?.data.kind).toBe("exact");
    expect(run.attempts).toHaveLength(1);
    const a = run.attempts[0];
    expect(a?.workerId).toBe("A");
    expect(a?.receipt?.data.receipt.transferMethod).toBe("default");
    expect(a && isEscrow(a)).toBe(false);
    expect(a && Object.values(stepStates(a))).toEqual(Array(7).fill("done"));
  });

  it("keeps a failover's two attempts apart: the failed one charged nothing", () => {
    const log = fixtureRunLog("failover");
    const run = deriveRun(log.runId, log.events);
    expect(run.attempts.map((a) => a.workerId)).toEqual(["C", "B"]);
    const [first, second] = run.attempts;
    expect(first?.jobFailed).toBeDefined();
    expect(first?.canceled).toBeDefined();
    expect(first?.settled).toBeUndefined();
    expect(first && stepStates(first).running).toBe("failed");
    expect(first && stepStates(first).settled).toBe("pending");
    expect(second?.settled).toBeDefined();
    expect(second?.receipt).toBeDefined();
    expect(run.reroutes).toHaveLength(1);
    expect(run.quotes).toHaveLength(2);
    expect(run.decisions.map((d) => d.data.kind)).toEqual(["exact", "counter"]);
  });

  it("marks only the steps whose events arrived", () => {
    const log = fixtureRunLog("cpu-tight");
    const upToVerified = log.events.slice(
      0,
      log.events.findIndex((e) => e.type === "payment.verified") + 1,
    );
    const run = deriveRun(log.runId, upToVerified);
    const a = run.attempts[0];
    expect(run.status).toBe("running");
    expect(a && stepStates(a)).toEqual({
      required: "done",
      signed: "done",
      verified: "active",
      running: "pending",
      delivered: "pending",
      settling: "pending",
      settled: "pending",
    });
  });

  it("orders events by id, whatever order they arrive in", () => {
    const log = fixtureRunLog("cpu-counter");
    const shuffled = [...log.events].reverse();
    const run = deriveRun(log.runId, shuffled);
    expect(run.events.map((e) => e.id)).toEqual(log.events.map((e) => e.id));
    expect(run.decisions[0]?.data.kind).toBe("counter");
    expect(run.status).toBe("completed");
  });

  it("never counts dev test jobs as runs", () => {
    const log = fixtureRunLog("cpu-tight");
    const dev = log.events.map((e) =>
      JobEvent.parse({ ...e, id: `dev-${e.id}`, runId: "dev-run", dev: true }),
    );
    expect(runIds([...log.events, ...dev])).toEqual([log.runId]);
    expect(deriveRun("dev-run", dev).events).toHaveLength(0);
  });

  it("finds my agent's latest balance", () => {
    const a = fixtureRunLog("cpu-tight", 20);
    const b = fixtureRunLog("gpu-image", 5);
    const balance = latestBalance([...a.events, ...b.events]);
    expect(balance?.runId).toBe(b.runId);
  });
});
