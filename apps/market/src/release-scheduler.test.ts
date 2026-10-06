import { explorerTxUrl, type JobEvent, type JobEventInput, type RunLog } from "@pekkah/protocol";
import { createLogger } from "@pekkah/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseOutcome, ReleasePlan } from "./escrow-release.js";
import { pendingReleases, ReleaseScheduler } from "./release-scheduler.js";
import { SELLER_A } from "./test-support/escrow.js";

const log = createLogger("release-test");
const T0 = Date.parse("2026-10-07T01:00:00Z");
const LOCK = "a".repeat(64);
const SUBMIT = "b".repeat(64);
const RELEASE = "c".repeat(64);
const BUYER = `addr_test1q${"p".repeat(97)}`;
const ASSET = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
const plan: ReleasePlan = {
  buyerAddress: BUYER,
  sellerAddress: SELLER_A,
  asset: ASSET,
  amountAtomic: "50000",
  buyerLovelace: "4003990",
  collateralReturnLovelace: "4003990",
  unlockTime: T0 + 10 * 60_000,
};
const submittedOk: ReleaseOutcome = {
  ok: true,
  dryRun: false,
  txHash: RELEASE,
  plan,
  feeLovelace: "668748",
  exUnits: [],
};
const releasedEvent = {
  source: "chain",
  type: "escrow.released",
  runId: "01RUN",
  jobId: "01JOB",
  data: {
    lockTxHash: LOCK,
    txHash: RELEASE,
    sellerAddress: SELLER_A,
    buyerAddress: BUYER,
    amountAtomic: "50000",
    asset: ASSET,
    collateralReturnLovelace: "4003990",
    explorerUrl: explorerTxUrl(RELEASE),
  },
};

function scheduler(outcomes: (ReleaseOutcome | Error)[], found = () => true) {
  const calls: string[] = [];
  const indexes: (number | undefined)[] = [];
  const emitted: JobEventInput[] = [];
  const s = new ReleaseScheduler({
    release: async ({ lockTxHash, outputIndex }) => {
      calls.push(lockTxHash);
      indexes.push(outputIndex);
      const next = outcomes.shift() ?? { ok: false, reason: "no outcome left", retry: false };
      if (next instanceof Error) throw next;
      return next;
    },
    txFound: async () => found(),
    emit: (event) => void emitted.push(event),
    log,
    now: () => Date.now(),
    pollMs: 5_000,
    polls: 3,
    backoffMs: () => 30_000,
    maxAttempts: 3,
  });
  return { s, calls, indexes, emitted };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("pending releases in saved runs", () => {
  const ev = (e: Partial<JobEvent> & Pick<JobEvent, "type" | "data">) =>
    ({ id: "x", ts: new Date(T0).toISOString(), source: "chain", ...e }) as JobEvent;
  const locked = ev({
    type: "escrow.locked",
    jobId: "01JOB",
    data: {
      txHash: LOCK,
      outputIndex: 1,
      escrowAddress: `addr_test1w${"z".repeat(52)}`,
      sellerAddress: SELLER_A,
      amountAtomic: "50000",
      asset: ASSET,
      collateralLovelace: "4003990",
      inputHash: "d".repeat(64),
      payByTime: String(T0 - 600_000),
      submitResultTime: String(T0),
      unlockTime: String(T0 + 10 * 60_000),
      externalDisputeUnlockTime: String(T0 + 30 * 60_000),
      explorerUrl: explorerTxUrl(LOCK),
    },
  } as never);
  const result = ev({
    type: "escrow.result_submitted",
    jobId: "01JOB",
    data: {
      lockTxHash: LOCK,
      txHash: SUBMIT,
      resultHash: "e".repeat(64),
      explorerUrl: explorerTxUrl(SUBMIT),
    },
  } as never);
  const run = (events: JobEvent[]): RunLog => ({ runId: "01RUN", events });

  it("are the locks with a submitted result and no release or refund", () => {
    expect(pendingReleases([run([locked, result])])).toEqual([
      {
        lockTxHash: LOCK,
        outputIndex: 1,
        unlockTime: T0 + 10 * 60_000,
        runId: "01RUN",
        jobId: "01JOB",
      },
    ]);
    expect(pendingReleases([run([locked])])).toEqual([]);
    const released = ev({ ...releasedEvent, data: releasedEvent.data } as never);
    expect(pendingReleases([run([locked, result, released])])).toEqual([]);
    // Without the lock's escrow.locked there is no unlock time: the endpoint covers it.
    expect(pendingReleases([run([result])])).toEqual([]);
  });
});

describe("the release scheduler", () => {
  const pending = {
    lockTxHash: LOCK,
    unlockTime: T0 + 10 * 60_000,
    runId: "01RUN",
    jobId: "01JOB",
  };

  it("releases a minute after the unlock, and reports it once the chain shows it", async () => {
    const { s, calls, emitted } = scheduler([submittedOk]);
    s.add(pending);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 59_000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual([LOCK]);
    expect(emitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(emitted).toEqual([releasedEvent]);
    expect(s.pending()).toEqual([]);
  });

  it("retries what may pass, and gives up after its attempts", async () => {
    const later: ReleaseOutcome = { ok: false, reason: "chain unavailable", retry: true };
    const { s, calls, emitted } = scheduler([later, new Error("boom"), later]);
    s.add({ ...pending, unlockTime: T0 - 120_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(3);
    expect(emitted).toEqual([]);
    expect(s.pending()).toEqual([]);
  });

  it("drops a refusal that cannot pass, such as a lock with no result", async () => {
    const { s, calls } = scheduler([
      { ok: false, reason: "the escrow is in state 0, not ResultSubmitted", retry: false },
    ]);
    s.add({ ...pending, unlockTime: T0 - 120_000 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toEqual([LOCK]);
    expect(s.pending()).toEqual([]);
  });

  it("reports a release the chain already shows, without submitting another", async () => {
    const { s, emitted } = scheduler([
      { ok: false, reason: "spent", retry: false, releasedIn: { txHash: RELEASE, plan } },
    ]);
    s.add({ ...pending, unlockTime: T0 - 120_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted).toEqual([releasedEvent]);
  });

  it("tries again when a submitted release is not seen in time", async () => {
    let seen = false;
    const again: ReleaseOutcome = {
      ok: false,
      reason: "spent",
      retry: false,
      releasedIn: { txHash: RELEASE, plan },
    };
    const { s, calls, emitted } = scheduler([submittedOk, again], () => seen);
    s.add({ ...pending, unlockTime: T0 - 120_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toHaveLength(1);
    expect(emitted).toEqual([]);
    seen = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);
    expect(emitted).toEqual([releasedEvent]);
  });

  it("passes the lock's escrow output from escrow.locked to the release", async () => {
    const { s, calls, indexes } = scheduler([submittedOk]);
    const at = new Date(T0).toISOString();
    s.observe({
      id: "1",
      ts: at,
      source: "chain",
      type: "escrow.locked",
      runId: "01RUN",
      jobId: "01JOB",
      data: { txHash: LOCK, outputIndex: 2, unlockTime: String(T0 - 120_000) },
    } as unknown as JobEvent);
    s.observe({
      id: "2",
      ts: at,
      source: "chain",
      type: "escrow.result_submitted",
      runId: "01RUN",
      jobId: "01JOB",
      data: { lockTxHash: LOCK, txHash: SUBMIT },
    } as unknown as JobEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([LOCK]);
    expect(indexes).toEqual([2]);
  });

  it("schedules from live events and forgets a lock once it is released", async () => {
    const { s, calls } = scheduler([submittedOk]);
    const at = new Date(T0).toISOString();
    s.observe({
      id: "1",
      ts: at,
      source: "chain",
      type: "escrow.locked",
      runId: "01RUN",
      jobId: "01JOB",
      data: { txHash: LOCK, unlockTime: String(T0 + 10 * 60_000) },
    } as unknown as JobEvent);
    expect(s.pending()).toEqual([]);
    s.observe({
      id: "2",
      ts: at,
      source: "chain",
      type: "escrow.result_submitted",
      runId: "01RUN",
      jobId: "01JOB",
      data: { lockTxHash: LOCK, txHash: SUBMIT },
    } as unknown as JobEvent);
    expect(s.pending()).toEqual([pending]);
    s.observe({ id: "3", ts: at, ...releasedEvent } as unknown as JobEvent);
    expect(s.pending()).toEqual([]);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(calls).toEqual([]);
  });

  it("answers the endpoint at once, and refuses a second release while one is in flight", async () => {
    const { s, calls, emitted } = scheduler([submittedOk]);
    s.add(pending);
    const first = await s.releaseNow(pending);
    expect(first).toEqual(submittedOk);
    expect(await s.releaseNow(pending)).toEqual({ busy: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(emitted).toEqual([releasedEvent]);
    expect(calls).toEqual([LOCK]);
  });
});
