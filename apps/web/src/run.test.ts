import { JobEvent } from "@pekkah/protocol";
import { describe, expect, it } from "vitest";
import { fixtureRunLog } from "./dev/fixture";
import {
  BUSY_WINDOW_MS,
  busyRunId,
  currentStep,
  deriveRun,
  isEscrow,
  isRecentUnfinished,
  knownScenario,
  LIVE_WINDOW_MS,
  latestBalance,
  runIds,
  stepStates,
} from "./run";

/** The same events, as a free-form run from Claude via the MCP. */
function asCustomRun(events: JobEvent[]): JobEvent[] {
  return events.map((e) =>
    e.type === "run.started"
      ? { ...e, data: { ...e.data, scenario: "custom" as const, client: "Claude via MCP" } }
      : e,
  );
}

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

  it("follows a custom run: no preset scenario, the request it sent", () => {
    const log = fixtureRunLog("gpu-image");
    const run = deriveRun(log.runId, asCustomRun(log.events));
    expect(run.scenario).toBeUndefined();
    expect(run.client).toBe("Claude via MCP");
    expect(run.started?.data.request.workload).toBe("image");
    expect(run.status).toBe("completed");
    expect(run.attempts[0]?.receipt).toBeDefined();
  });
});

describe("knownScenario", () => {
  it("names preset scenarios only", () => {
    expect(knownScenario("gpu-image-escrow")).toBe("gpu-image-escrow");
    expect(knownScenario("custom")).toBeUndefined();
    expect(knownScenario("constructor")).toBeUndefined();
  });
});

describe("the current step", () => {
  it("follows the newest event through the story, and the run's end doesn't move it", () => {
    const log = fixtureRunLog("mcp");
    const upTo = (type: string) =>
      deriveRun(log.runId, log.events.slice(0, log.events.findIndex((e) => e.type === type) + 1));
    expect(currentStep(upTo("run.started"))).toBe("request");
    expect(currentStep(upTo("agent.balance"))).toBe("request");
    expect(currentStep(upTo("quote.issued"))).toBe("decision");
    expect(currentStep(upTo("payment.required"))).toBe("payment");
    expect(currentStep(upTo("escrow.locked"))).toBe("payment");
    expect(currentStep(upTo("receipt.issued"))).toBe("result");
    expect(currentStep(upTo("run.completed"))).toBe("result");
    expect(currentStep(deriveRun(log.runId, log.events))).toBe("escrow");
  });

  it("matches the escrow's later steps to their lock", () => {
    const log = fixtureRunLog("mcp-released", 40);
    const a = deriveRun(log.runId, log.events).attempts[0];
    expect(a?.resultSubmitted?.data.lockTxHash).toBe(a?.escrow?.data.txHash);
    expect(a?.released?.data.lockTxHash).toBe(a?.escrow?.data.txHash);
  });
});

describe("live and busy runs", () => {
  /** The MCP run up to its quote: my agent is waiting on my answer. */
  function waiting(minutesAgo: number) {
    const log = fixtureRunLog("mcp", minutesAgo);
    const events = log.events.filter((e) =>
      ["run.started", "agent.balance", "quote.issued"].includes(e.type),
    );
    return { runId: log.runId, events };
  }

  it("counts an unfinished run opened mid-way as live for 15 minutes after its last event", () => {
    const { runId, events } = waiting(5);
    const run = deriveRun(runId, events);
    const last = Date.parse(run.lastTs ?? "");
    expect(isRecentUnfinished(run, last + LIVE_WINDOW_MS - 1000, LIVE_WINDOW_MS)).toBe(true);
    expect(isRecentUnfinished(run, last + LIVE_WINDOW_MS + 1000, LIVE_WINDOW_MS)).toBe(false);
    const done = fixtureRunLog("mcp", 5);
    const finished = deriveRun(done.runId, done.events);
    expect(isRecentUnfinished(finished, Date.parse(finished.lastTs ?? ""), LIVE_WINDOW_MS)).toBe(
      false,
    );
  });

  it("blocks the run buttons like the server's 409: unfinished, with an event in 2 minutes", () => {
    const { runId, events } = waiting(1);
    const last = Math.max(...events.map((e) => Date.parse(e.ts)));
    expect(busyRunId(events, last + BUSY_WINDOW_MS - 1000)).toBe(runId);
    expect(busyRunId(events, last + BUSY_WINDOW_MS + 1000)).toBeUndefined();
    // A finished run blocks nothing.
    const done = fixtureRunLog("gpu-image", 1);
    expect(busyRunId(done.events, Date.now())).toBeUndefined();
    // Nor does a late chain event from a run whose start is out of view.
    const release = fixtureRunLog("mcp-released", 40).events.filter(
      (e) => e.type === "escrow.released",
    );
    expect(busyRunId(release, Date.parse(release[0]?.ts ?? ""))).toBeUndefined();
  });

  it("shows the shown run's balance: the MCP and the hosted agent pay from different accounts", () => {
    // Fixture ids follow creation, like real ulids follow time: the hosted run is the newer one.
    const mcp = fixtureRunLog("mcp", 5);
    const hosted = fixtureRunLog("gpu-image", 2);
    const all = [...mcp.events, ...hosted.events];
    expect(latestBalance(all, mcp.runId)?.runId).toBe(mcp.runId);
    expect(latestBalance(all)?.runId).toBe(hosted.runId);
  });
});
