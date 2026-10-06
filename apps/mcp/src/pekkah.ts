import type { Buyer } from "@pekkah/buyer";
import {
  type AgentEventType,
  ComputeRequest,
  type CounterOffer,
  type EventData,
  explorerTxUrl,
  formatUsd,
  formatUsdAtomic,
  JobResultBody,
  type Offer,
  Quote,
  RUN_ID_HEADER,
  WorkerSnapshot,
} from "@pekkah/protocol";
import { z } from "zod";
import { pngToJpeg } from "./jpeg.js";

// The two tools (PLAN, B1). Everything a tool says comes from the market's answers and
// the payment's outcome; nothing is guessed. My agent pays only after the job delivers:
// a failed job is cancelled and charges nothing.

export type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

export interface Deps {
  marketUrl: string;
  asset: string;
  buyer: Pick<Buyer, "buy" | "idle">;
  fetch?: typeof fetch;
  newRunId: () => string;
  /** Who starts the runs, for the market's page, e.g. "Claude via MCP". */
  client?: () => string;
  /** Posts my agent's events to the market (needs AGENT_TOKEN); a no-op without it. */
  emit?: <T extends AgentEventType>(
    type: T,
    data: EventData<T>,
    ids: { runId: string; jobId?: string },
  ) => Promise<void>;
}

const text = (t: string): ToolResult["content"][number] => ({ type: "text", text: t });
const fail = (t: string): ToolResult => ({ content: [text(t)], isError: true });

/** Answers that mean the offer can't be bought any more; nothing was charged. */
const OFFER_GONE = new Set([404, 409, 410]);
const IMAGE_DEADLINE_SEC = 60;

export async function marketText(deps: Pick<Deps, "marketUrl" | "fetch">): Promise<ToolResult> {
  const f = deps.fetch ?? fetch;
  const res = await f(`${deps.marketUrl}/api/workers`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return fail(`The market answered ${res.status}.`);
  const workers = z.array(WorkerSnapshot).parse(await res.json());
  if (workers.length === 0) return { content: [text("No worker is connected to the market.")] };
  const hardware = (w: WorkerSnapshot) =>
    w.hardware.gpu
      ? `${w.hardware.gpu.name}, ${w.hardware.gpu.vramGb} GB VRAM, ${w.hardware.vcpus} vCPU`
      : `${w.hardware.vcpus} vCPU, ${w.hardware.memGb} GB RAM`;
  const measured = (w: WorkerSnapshot) =>
    [
      w.calibration.fractal
        ? `CPU render ${w.calibration.fractal.calibSec.toFixed(1)} s${w.calibration.fractal.verified ? " (answer checked)" : " (failed its check)"}`
        : null,
      w.calibration.image
        ? `1024² image in ${w.calibration.image.secImage1024x4.toFixed(1)} s (timed)`
        : null,
    ]
      .filter(Boolean)
      .join("; ");
  // Before PR-13 a market didn't report `selling`; every worker it listed was allowlisted.
  const selling = workers.filter((w) => w.selling !== false);
  const joining = workers.filter((w) => w.selling === false);
  const lines = selling.map((w) => {
    const prices = w.prices
      .map(
        (p) =>
          `${p.workload} ${formatUsd(p.usd)}${w.warm.includes(p.workload) ? "" : " (not ready)"}`,
      )
      .join(", ");
    const m = measured(w);
    return `- ${w.name} (${w.workerId}), ${w.status}${w.escrowSeller ? ", sells through Masumi escrow" : ""}: ${hardware(w)} (reported by the machine). Sells ${prices}.${m ? ` Measured by the market: ${m}.` : ""}`;
  });
  const parts = [
    `Workers on Pekkah (Cardano preprod, paid in test tUSDM per job):\n${lines.join("\n") || "- none selling right now"}`,
  ];
  if (joining.length) {
    parts.push(
      `Joining the network (on probation: listed and measured, but they sell nothing until they are allowlisted):\n${joining
        .map((w) => {
          const m = measured(w);
          return `- ${w.workerId}, ${w.status}: ${hardware(w)} (reported by the machine).${m ? ` Measured by the market: ${m}.` : ""}`;
        })
        .join("\n")}`,
    );
  }
  return { content: [text(parts.join("\n"))] };
}

export const GenerateImageInput = {
  prompt: z.string().trim().min(1).max(300).describe("What to draw, at most 300 characters."),
  maxUsd: z
    .number()
    .positive()
    .max(0.1)
    .default(0.05)
    .describe("The most my agent may pay, in USD (test tUSDM). At most 0.10."),
  seed: z
    .number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional()
    .describe("Optional, for a repeatable image."),
};

type Choice = { kind: "exact" | "counter"; offer: Offer | CounterOffer; reasons: string[] };

/** The best exact offer; else a counter-offer within maxUsd and the deadline; else none. */
export function choose(
  quote: Quote,
  maxUsd: number,
): Choice | { kind: "declined"; reasons: string[] } {
  const exact = quote.offers[0];
  if (exact) {
    return {
      kind: "exact",
      offer: exact,
      reasons: [
        `${exact.workerId} offers ${formatUsdAtomic(exact.priceAtomic)}, about ${Math.round(exact.estSec)} s.`,
      ],
    };
  }
  const counter = quote.counterOffer;
  if (!counter) {
    return {
      kind: "declined",
      reasons: [
        "No worker can make this image now.",
        ...quote.rejected.map((r) => `${r.workerId}: ${r.detail}`),
      ],
    };
  }
  if (counter.priceUsd > maxUsd) {
    return {
      kind: "declined",
      reasons: [counter.reason, `That is above the ${formatUsd(maxUsd)} you allowed.`],
    };
  }
  if (counter.estSec > quote.request.constraints.deadlineSec) {
    return { kind: "declined", reasons: [counter.reason, "It would miss the deadline."] };
  }
  return {
    kind: "counter",
    offer: counter,
    reasons: [counter.reason, "Within your limit: accepted."],
  };
}

export async function generateImage(
  input: { prompt: string; maxUsd: number; seed?: number },
  deps: Deps,
): Promise<ToolResult> {
  const f = deps.fetch ?? fetch;
  const emit = deps.emit ?? (async () => {});
  const runId = deps.newRunId();
  const started = Date.now();
  const request = ComputeRequest.parse({
    workload: "image",
    params: {
      prompt: input.prompt,
      seed: input.seed ?? Math.floor(Math.random() * 4_294_967_295),
      size: 1024,
      steps: 4,
    },
    constraints: { gpu: true, minVramGb: 16, deadlineSec: IMAGE_DEADLINE_SEC },
    budget: { maxUsd: input.maxUsd },
  });
  const failed = async (reason: string) => {
    await emit("run.failed", { reason }, { runId });
    return fail(reason);
  };
  await emit(
    "run.started",
    { scenario: "custom", ...(deps.client ? { client: deps.client() } : {}), request },
    { runId },
  );

  // One quote, and one more only if the offer was gone before we paid (nothing charged).
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await f(`${deps.marketUrl}/api/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", [RUN_ID_HEADER]: runId },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return failed(`The market refused the quote (HTTP ${res.status}).`);
    const quote = Quote.parse(await res.json());
    const choice = choose(quote, input.maxUsd);
    await emit(
      "agent.decision",
      {
        kind: choice.kind,
        ...(choice.kind === "declined" ? {} : { chosen: choice.offer }),
        reasons: choice.reasons,
      },
      { runId },
    );
    if (choice.kind === "declined") return failed(`Not bought. ${choice.reasons.join(" ")}`);

    const offer = choice.offer;
    await deps.buyer.idle();
    const bought = await deps.buyer.buy({
      url: `${deps.marketUrl}/api/jobs/${offer.offerId}`,
      headers: { [RUN_ID_HEADER]: runId },
      expect: { payTo: offer.payTo, amountAtomic: offer.priceAtomic, asset: deps.asset },
      runId,
      offerId: offer.offerId,
    });
    if (OFFER_GONE.has(bought.status) && !bought.txHash && attempt === 1) continue;

    const body = JobResultBody.safeParse(bought.body);
    if (bought.status !== 200 || !bought.settle?.success || !body.success) {
      return failed(
        bought.status === 502
          ? `The job failed on ${offer.workerId}. The payment was cancelled: nothing was charged.`
          : bought.status === 402 && bought.txHash
            ? `The payment didn't settle (tx ${bought.txHash}); the market keeps the result until it does.`
            : `The market answered ${bought.status}; nothing was bought.`,
      );
    }
    const job = body.data;
    const totalMs = Date.now() - started;
    await emit(
      "run.completed",
      { jobId: job.jobId, workerId: job.workerId, txHash: job.txHash, totalMs },
      { runId, jobId: job.jobId },
    );
    const resultUrl = `${deps.marketUrl}${job.resultUrl}`;
    const receipt = [
      `Paid ${formatUsdAtomic(offer.priceAtomic)} in test tUSDM to worker ${job.workerId}, the GPU that made the image, after it was delivered.`,
      `Transaction: ${explorerTxUrl(job.txHash)}`,
      `Made in ${(job.durationMs / 1000).toFixed(1)} s on ${job.workerId}. Full PNG: ${resultUrl} (sha256 ${job.sha256}).`,
      "Cardano preprod: test tokens, no real money.",
    ].join("\n");
    // Paid by now: whatever happens to the download, the receipt goes back.
    try {
      const png = await f(resultUrl, { signal: AbortSignal.timeout(30_000) });
      if (!png.ok) {
        return {
          content: [text(`${receipt}\n(The image couldn't be fetched: HTTP ${png.status}.)`)],
        };
      }
      const bytes = Buffer.from(await png.arrayBuffer());
      // MCP clients drop large results, so the image travels as a JPEG; the PNG stays linked.
      const image =
        job.mime === "image/png"
          ? { data: pngToJpeg(bytes).toString("base64"), mimeType: "image/jpeg" }
          : { data: bytes.toString("base64"), mimeType: job.mime };
      return { content: [{ type: "image", ...image }, text(receipt)] };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { content: [text(`${receipt}\n(The image couldn't be fetched: ${why}.)`)] };
    }
  }
  return failed("The offers kept expiring before payment; nothing was charged. Try again.");
}

/** How long one tool call waits for a purchase: under the 60 s that MCP clients often allow. */
export const WAIT_MS = 45_000;
/** Finished purchases kept for pekkah_get_image; ones still in flight are never dropped. */
const KEEP = 20;

export function pendingResult(runId: string): ToolResult {
  return {
    content: [
      text(
        `Still in progress: the worker makes the image, then the payment settles on Cardano (usually 20 to 80 s). Nothing is lost and nothing is paid twice. Call pekkah_result with runId "${runId}" to get the image and the receipt.`,
      ),
    ],
  };
}

/**
 * Purchases outlive a tool call: a paid image takes longer than many clients wait for one
 * request, so the first call returns early with a run id and pekkah_get_image collects it.
 */
export class PurchaseBook {
  private readonly runs = new Map<string, { done: Promise<ToolResult>; settled: boolean }>();

  constructor(
    private readonly deps: Deps,
    private readonly waitMs = WAIT_MS,
    private readonly keep = KEEP,
  ) {}

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  start(input: { prompt: string; maxUsd: number; seed?: number }): string {
    const runId = this.deps.newRunId();
    const done = generateImage(input, { ...this.deps, newRunId: () => runId }).catch(
      (err: unknown) => fail(`Pekkah failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    const entry = { done, settled: false };
    void done.then(() => {
      entry.settled = true;
    });
    this.runs.set(runId, entry);
    // Oldest first, and only finished ones: a purchase in flight may still be paying.
    for (const [old, other] of this.runs) {
      if (this.runs.size <= this.keep) break;
      if (other.settled) this.runs.delete(old);
    }
    return runId;
  }

  /** The outcome, or null if it isn't ready within the wait. `tick` runs every 10 s. */
  async wait(
    runId: string,
    tick?: (waitedSec: number) => Promise<void>,
  ): Promise<ToolResult | null> {
    const done = this.runs.get(runId)?.done;
    if (!done) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;
    const started = Date.now();
    try {
      if (tick) {
        ticker = setInterval(
          () => void tick(Math.round((Date.now() - started) / 1000)).catch(() => {}),
          10_000,
        );
      }
      return await Promise.race([
        done,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.waitMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearInterval(ticker);
    }
  }
}
