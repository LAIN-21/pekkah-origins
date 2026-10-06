// DEV ONLY. main.tsx loads this module only when import.meta.env.DEV is true and
// the URL has ?fixture=1, so it never reaches the production bundle (the build
// check greps dist/ for FIXTURE_MARKER). Nothing here is real: addresses, hashes,
// timings and results are made up to develop the page without a market.
//
//   ?fixture=1                     idle, with a replay of a made-up cpu-counter run
//   ?fixture=1&run=failover        plays that scenario live after 1.5 s
//   ?fixture=1&speed=4             plays four times faster

import {
  DEFAULT_ASSET,
  type DemoState,
  type EventType,
  explorerTxUrl,
  JobEvent,
  type Offer,
  type PublicScenario,
  type Quote,
  type RunLog,
  ScenarioName,
  scenarioRequest,
  UiMessage,
  usdToAtomic,
  type WorkerSnapshot,
} from "@pekkah/protocol";
import type { FeedHandlers } from "../feed";
import type { FeedSource } from "../source";

export const FIXTURE_MARKER = "pekkah-dev-fixture-data";

// bech32 characters only, so the made-up addresses pass the protocol's checks.
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function fakeAddress(tag: number): string {
  let out = "addr_test1q";
  for (let i = 0; i < 57; i++) out += BECH32[(i * 7 + tag * 13) % 32];
  return out;
}

function fakeHex(tag: number, fill: string): string {
  return (tag.toString(16).padStart(8, "0") + fill.repeat(16)).slice(0, 64);
}

const PAYOUT: Record<string, string> = { A: fakeAddress(1), B: fakeAddress(2), C: fakeAddress(3) };
const PRICE_USD: Record<string, number> = { A: 0.05, B: 0.03, C: 0.02 };

function fixtureWorkers(at: string): WorkerSnapshot[] {
  const fractal = (calibSec: number) => ({
    overheadSec: 1.4,
    calibSec,
    secPerIter: (calibSec - 1.4) / 41_000_000,
    verified: true,
    challenge: 3,
    at,
  });
  return [
    {
      workerId: "A",
      name: "Worker A",
      payTo: PAYOUT.A as string,
      hardware: {
        cpuModel: "Intel Xeon Platinum 8468",
        vcpus: 8,
        memGb: 32,
        gpu: { name: "NVIDIA RTX 4000 Ada Generation", vramGb: 20, driver: "580.173.02" },
      },
      prices: [
        { workload: "fractal", usd: 0.05, atomic: "50000" },
        { workload: "image", usd: 0.05, atomic: "50000" },
      ],
      status: "online",
      calibration: {
        fractal: fractal(3.4),
        image: { secImage1024x4: 6.9, verified: false, at },
      },
      warm: ["fractal", "image"],
      util: { cpuPct: 3, gpuPct: 0, vramUsedGb: 12.8 },
      lastSeenAt: at,
    },
    {
      workerId: "B",
      name: "Worker B",
      payTo: PAYOUT.B as string,
      hardware: { cpuModel: "AMD EPYC 7543", vcpus: 8, memGb: 16 },
      prices: [{ workload: "fractal", usd: 0.03, atomic: "30000" }],
      status: "online",
      calibration: { fractal: fractal(2.9) },
      warm: ["fractal"],
      util: { cpuPct: 2 },
      lastSeenAt: at,
    },
    {
      workerId: "C",
      name: "Worker C",
      payTo: PAYOUT.C as string,
      hardware: { cpuModel: "DO-Regular", vcpus: 2, memGb: 2 },
      prices: [{ workload: "fractal", usd: 0.02, atomic: "20000" }],
      status: "online",
      calibration: { fractal: fractal(9.6) },
      warm: ["fractal"],
      util: { cpuPct: 4 },
      lastSeenAt: at,
    },
  ];
}

const RESULT_SVG = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5B8CFF"/><stop offset="1" stop-color="#35E0A1"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><text x="256" y="262" font-family="sans-serif" font-size="28" text-anchor="middle" fill="#0B0F19">${FIXTURE_MARKER}</text></svg>`,
)}`;

type EventInput = {
  type: EventType;
  source: JobEvent["source"];
  data: unknown;
  jobId?: string;
};

type Step =
  | { at: number; event: EventInput }
  | { at: number; workers: (ws: WorkerSnapshot[]) => WorkerSnapshot[] }
  | { at: number; demo: (d: DemoState) => DemoState };

function offer(
  quoteId: string,
  workerId: string,
  workload: Offer["workload"],
  estSec: number,
  kind: Offer["kind"],
): Offer {
  const usd = PRICE_USD[workerId] as number;
  return {
    offerId: `of-${quoteId}-${workerId}`,
    quoteId,
    workerId,
    workload,
    priceUsd: usd,
    priceAtomic: usdToAtomic(usd),
    asset: DEFAULT_ASSET,
    payTo: PAYOUT[workerId] as string,
    estSec,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    kind,
  };
}

function setStatus(
  workerId: string,
  status: WorkerSnapshot["status"],
  util: WorkerSnapshot["util"],
): (ws: WorkerSnapshot[]) => WorkerSnapshot[] {
  return (ws) => ws.map((w) => (w.workerId === workerId ? { ...w, status, util } : w));
}

let attemptTag = 0;

/** One paid attempt from the 402 to the end, starting at `t` ms. */
function attempt(
  t: number,
  o: Offer,
  runId: string,
  options: {
    jobSec: number;
    deadlineSec: number;
    fails?: boolean;
    settleSec?: number;
    gpu?: boolean;
  },
): { steps: Step[]; end: number } {
  const tag = ++attemptTag;
  const txHash = fakeHex(tag, "dead");
  const jobId = `job-${runId}-${tag}`;
  const w = o.workerId;
  const busy = options.gpu
    ? { cpuPct: 12, gpuPct: 97, vramUsedGb: 16.9 }
    : { cpuPct: 96, gpuPct: undefined, vramUsedGb: undefined };
  const idle = options.gpu ? { cpuPct: 3, gpuPct: 0, vramUsedGb: 12.8 } : { cpuPct: 3 };
  const jobMs = options.jobSec * 1000;
  const steps: Step[] = [
    {
      at: t,
      event: {
        type: "payment.required",
        source: "market",
        data: {
          offerId: o.offerId,
          workerId: w,
          payTo: o.payTo,
          amountAtomic: o.priceAtomic,
          asset: o.asset,
          transferMethod: "default",
        },
      },
    },
    {
      at: t + 900,
      event: {
        type: "payment.signed",
        source: "agent",
        data: {
          txHash,
          payTo: o.payTo,
          amountAtomic: o.priceAtomic,
          offerId: o.offerId,
          transferMethod: "default",
        },
      },
    },
    {
      at: t + 1700,
      event: {
        type: "payment.verified",
        source: "market",
        data: {
          txHash,
          offerId: o.offerId,
          workerId: w,
          payTo: o.payTo,
          amountAtomic: o.priceAtomic,
          transferMethod: "default",
        },
      },
    },
    {
      at: t + 1800,
      event: {
        type: "job.dispatched",
        source: "market",
        jobId,
        data: {
          workerId: w,
          workload: o.workload,
          kind: "paid",
          deadlineSec: options.deadlineSec,
          offerId: o.offerId,
          txHash,
          estSec: o.estSec,
        },
      },
    },
    {
      at: t + 2100,
      event: { type: "job.running", source: "worker", jobId, data: { workerId: w } },
    },
    { at: t + 2200, workers: setStatus(w, "busy", busy) },
    {
      at: t + 2100 + jobMs * 0.5,
      event: { type: "job.progress", source: "worker", jobId, data: { workerId: w, pct: 50 } },
    },
  ];
  let at = t + 2100 + jobMs;
  if (options.fails) {
    steps.push(
      {
        at: t + 2100 + jobMs * 0.6,
        event: {
          type: "job.failed",
          source: "worker",
          jobId,
          data: { workerId: w, reason: "The job container was killed (exit 137)." },
        },
      },
      { at: t + 2200 + jobMs * 0.6, workers: setStatus(w, "online", idle) },
      {
        at: t + 2400 + jobMs * 0.6,
        event: {
          type: "payment.canceled",
          source: "market",
          data: { txHash, reason: "handler_failed" },
        },
      },
    );
    return { steps, end: t + 2400 + jobMs * 0.6 };
  }
  const sha256 = fakeHex(tag, "beef");
  const settleMs = (options.settleSec ?? 21) * 1000;
  steps.push(
    {
      at,
      event: {
        type: "job.completed",
        source: "worker",
        jobId,
        data: {
          workerId: w,
          durationMs: jobMs,
          sha256,
          mime: "image/png",
          bytes: 1_400_000,
        },
      },
    },
    { at: at + 100, workers: setStatus(w, "online", idle) },
    {
      at: at + 200,
      event: {
        type: "payment.settling",
        source: "market",
        data: { txHash, transferMethod: "default" },
      },
    },
  );
  at += 200 + settleMs;
  steps.push(
    {
      at,
      event: {
        type: "payment.settled",
        source: "chain",
        data: {
          txHash,
          confirmations: 1,
          explorerUrl: explorerTxUrl(txHash),
          transferMethod: "default",
        },
      },
    },
    {
      at: at + 100,
      event: {
        type: "receipt.issued",
        source: "market",
        jobId,
        data: {
          receipt: {
            txHash,
            network: "cardano:preprod",
            payTo: o.payTo,
            amountAtomic: o.priceAtomic,
            asset: o.asset,
            transferMethod: "default",
            confirmations: 1,
            feeLovelace: "183125",
            lovelaceInPaymentOutput: "1189560",
            explorerUrl: explorerTxUrl(txHash),
            settledAt: new Date().toISOString(),
          },
          resultUrl: RESULT_SVG,
        },
      },
    },
    {
      at: at + 400,
      event: {
        type: "run.completed",
        source: "agent",
        data: { jobId, workerId: w, txHash, totalMs: at + 400 },
      },
    },
  );
  return { steps, end: at + 400 };
}

function quoteStep(at: number, quote: Quote): Step {
  return { at, event: { type: "quote.issued", source: "market", data: { quote } } };
}

function decisionStep(
  at: number,
  kind: "exact" | "counter" | "declined",
  chosen: Offer | undefined,
  reasons: string[],
): Step {
  return {
    at,
    event: { type: "agent.decision", source: "agent", data: { kind, chosen, reasons } },
  };
}

/** The made-up steps of one scenario, with times in ms from the run's start. */
export function scenarioSteps(scenario: ScenarioName, runId: string): Step[] {
  const request = scenarioRequest(scenario);
  const steps: Step[] = [
    {
      at: 0,
      demo: (d) => ({ ...d, running: true, runId, cooldownUntil: null }),
    },
    { at: 0, event: { type: "run.started", source: "agent", data: { scenario, request } } },
  ];
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const deadlineSec = request.constraints.deadlineSec;
  let end = 0;

  if (scenario === "gpu-image" || scenario === "gpu-image-escrow") {
    const q = `q-${runId}-1`;
    const a = offer(q, "A", "image", 9.3, "exact");
    steps.push(
      quoteStep(800, {
        quoteId: q,
        runId,
        request,
        offers: [a],
        marketPriceUsd: 0.05,
        rejected: [
          { workerId: "B", reason: "no_gpu", detail: "No GPU" },
          { workerId: "C", reason: "no_gpu", detail: "No GPU" },
        ],
        expiresAt,
      }),
      decisionStep(1200, "exact", a, [
        "Only A has a GPU with at least 16 GB.",
        "A asks $0.05, within my budget of $0.05, and estimates about 9 s for a 60 s deadline.",
      ]),
    );
    const paid = attempt(1600, a, runId, { jobSec: 7.4, deadlineSec, gpu: true });
    steps.push(...paid.steps);
    end = paid.end;
  } else if (scenario === "cpu-counter") {
    const q = `q-${runId}-1`;
    const c = { ...offer(q, "C", "fractal", 31, "counter") };
    steps.push(
      quoteStep(800, {
        quoteId: q,
        runId,
        request,
        offers: [],
        counterOffer: {
          ...c,
          reason:
            "No offer at or below $0.015. Market price $0.03. Next best: C at $0.02, about 31 s",
        },
        marketPriceUsd: 0.03,
        rejected: [
          { workerId: "A", reason: "over_budget", detail: "$0.05 > $0.015" },
          { workerId: "B", reason: "over_budget", detail: "$0.03 > $0.015" },
          { workerId: "C", reason: "over_budget", detail: "$0.02 > $0.015" },
        ],
        expiresAt,
      }),
      decisionStep(1300, "counter", c, [
        "No worker sells at or below my offer of $0.015.",
        "The counter-offer from C at $0.02 is within my private ceiling.",
        "About 31 s fits my 120 s deadline, so I accept it.",
      ]),
    );
    const paid = attempt(1700, c, runId, { jobSec: 29.5, deadlineSec });
    steps.push(...paid.steps);
    end = paid.end;
  } else if (scenario === "cpu-tight") {
    const q = `q-${runId}-1`;
    const b = offer(q, "B", "fractal", 11.6, "exact");
    steps.push(
      quoteStep(800, {
        quoteId: q,
        runId,
        request,
        offers: [b],
        marketPriceUsd: 0.03,
        rejected: [
          { workerId: "A", reason: "over_budget", detail: "$0.05 > $0.03" },
          { workerId: "C", reason: "too_slow", detail: "About 41 s, deadline 20 s (measured)" },
        ],
        expiresAt,
      }),
      decisionStep(1200, "exact", b, [
        "B asks $0.03, within my budget, and estimates about 12 s for a 20 s deadline.",
      ]),
    );
    const paid = attempt(1600, b, runId, { jobSec: 10.8, deadlineSec });
    steps.push(...paid.steps);
    end = paid.end;
  } else {
    // failover: C is killed mid-job, nothing is charged, my agent re-quotes without C.
    const q1 = `q-${runId}-1`;
    const c = offer(q1, "C", "fractal", 44, "exact");
    steps.push(
      quoteStep(800, {
        quoteId: q1,
        runId,
        request,
        offers: [c],
        marketPriceUsd: 0.03,
        rejected: [
          { workerId: "A", reason: "over_budget", detail: "$0.05 > $0.02" },
          { workerId: "B", reason: "over_budget", detail: "$0.03 > $0.02" },
        ],
        expiresAt,
      }),
      decisionStep(1200, "exact", c, ["C asks $0.02, within my budget of $0.02."]),
    );
    const first = attempt(1600, c, runId, { jobSec: 40, deadlineSec, fails: true });
    steps.push(...first.steps);
    let t = first.end + 300;
    const q2 = `q-${runId}-2`;
    const b = { ...offer(q2, "B", "fractal", 11.6, "counter") };
    steps.push(
      {
        at: t,
        event: {
          type: "agent.reroute",
          source: "agent",
          data: {
            excluded: ["C"],
            reason: "C's job failed and nothing was charged. Asking again without C.",
          },
        },
      },
      quoteStep(t + 700, {
        quoteId: q2,
        runId,
        request: { ...request, constraints: { ...request.constraints, exclude: ["C"] } },
        offers: [],
        counterOffer: {
          ...b,
          reason:
            "No offer at or below $0.02. Market price $0.03. Next best: B at $0.03, about 12 s",
        },
        marketPriceUsd: 0.03,
        rejected: [
          { workerId: "A", reason: "over_budget", detail: "$0.05 > $0.02" },
          { workerId: "B", reason: "over_budget", detail: "$0.03 > $0.02" },
          { workerId: "C", reason: "excluded", detail: "Excluded by my agent" },
        ],
        expiresAt,
      }),
      decisionStep(t + 1100, "counter", b, [
        "No worker sells at or below $0.02 without C.",
        "B's counter-offer at $0.03 is within my private ceiling, so I accept it.",
      ]),
    );
    t += 1500;
    const second = attempt(t, b, runId, { jobSec: 10.9, deadlineSec });
    steps.push(...second.steps);
    end = second.end;
  }

  steps.push(
    {
      at: end + 200,
      event: {
        type: "agent.balance",
        source: "agent",
        data: { lovelace: "9318455012", assetAtomic: "998610000" },
      },
    },
    {
      at: end + 300,
      demo: (d) => ({
        running: false,
        cooldownUntil: new Date(Date.now() + 120_000).toISOString(),
        runsLeftToday: Math.max(0, d.runsLeftToday - 1),
      }),
    },
  );
  return steps;
}

let eventSeq = 0;

function toEvent(prefix: string, input: EventInput, runId: string, ts: string): JobEvent {
  eventSeq += 1;
  return JobEvent.parse({
    id: `${prefix}${String(eventSeq).padStart(8, "0")}`,
    ts,
    runId,
    ...input,
  });
}

/** A finished made-up run, as GET /api/runs/latest would return it. */
export function fixtureRunLog(scenario: ScenarioName, minutesAgo = 7): RunLog {
  const runId = `fixture-replay-${scenario}`;
  const origin = Date.now() - minutesAgo * 60_000;
  const events = scenarioSteps(scenario, runId).flatMap((s) =>
    "event" in s ? [toEvent("fa", s.event, runId, new Date(origin + s.at).toISOString())] : [],
  );
  return { runId, scenario, startedAt: new Date(origin).toISOString(), events };
}

export function fixtureSource(params: URLSearchParams): FeedSource {
  const speed = Math.max(0.25, Number(params.get("speed") ?? "1") || 1);
  const autoplay = params.get("run");
  const timers: ReturnType<typeof setTimeout>[] = [];
  let handlers: FeedHandlers | null = null;
  let workers = fixtureWorkers(new Date().toISOString());
  let demo: DemoState = { running: false, cooldownUntil: null, runsLeftToday: 40 };
  let runCount = 0;

  const emit = (message: UiMessage) => handlers?.onMessage(UiMessage.parse(message));

  const play = (scenario: ScenarioName): string => {
    runCount += 1;
    const runId = `fixture-live-${runCount}`;
    for (const step of scenarioSteps(scenario, runId)) {
      timers.push(
        setTimeout(() => {
          if ("event" in step) {
            emit({
              type: "event",
              event: toEvent("fb", step.event, runId, new Date().toISOString()),
            });
          } else if ("workers" in step) {
            workers = step.workers(workers);
            emit({ type: "workers", workers });
          } else {
            demo = step.demo(demo);
            emit({ type: "demo", demo });
          }
        }, step.at / speed),
      );
    }
    return runId;
  };

  return {
    label: "Dev fixture: made-up data, not a real market",
    connect(h) {
      handlers = h;
      h.onConnection("open");
      emit({ type: "snapshot", workers, recentEvents: [], demo });
      const scenario = ScenarioName.safeParse(autoplay);
      if (scenario.success) timers.push(setTimeout(() => play(scenario.data), 1500));
      return () => {
        handlers = null;
        for (const t of timers) clearTimeout(t);
      };
    },
    async latestRun() {
      return fixtureRunLog("cpu-counter");
    },
    async startRun(scenario: PublicScenario) {
      if (demo.running) return { ok: false, status: 409, message: "A run is already in progress." };
      return { ok: true, runId: play(scenario) };
    },
  };
}
