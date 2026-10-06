import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Buyer, PaymentExpectation } from "@pekkah/buyer";
import {
  ComputeRequest,
  type CounterOffer,
  compareAtomic,
  type EventOf,
  explorerTxUrl,
  formatAtomic,
  formatLovelace,
  formatUsd,
  formatUsdAtomic,
  type JobEvent,
  JobResultBody,
  MASUMI_LOCK_LABEL,
  MASUMI_REFUNDED_LABEL,
  MASUMI_RELEASED_LABEL,
  NETWORK,
  type Offer,
  Quote,
  RUN_ID_HEADER,
  RunLog,
  usdToAtomic,
  WorkerSnapshot,
} from "@pekkah/protocol";
import { masumiEscrowAddress } from "@x402/cardano";
import { z } from "zod";
import { pngToJpeg } from "./jpeg.js";
import type { Deps, ToolResult } from "./pekkah.js";

// The shopping tools (PLAN2 PR-14). Quotes are free. My agent buys only offers it quoted
// itself, keeps to the budget my human gave, and buys above it only when it states that my
// human approved: that statement is recorded as my agent's, never as proof. The wallet's
// spend caps stay the hard limit. Everything a tool says comes from the market's answers, the
// events the market recorded and the payment's outcome.

const ID = /^[0-9A-Za-z_-]{1,64}$/;
/** Answers that mean the offer can't be bought any more; nothing was charged. */
const OFFER_GONE = new Set([404, 409, 410]);
/** An offer this close to its expiry is quoted again before paying. */
const EXPIRY_MARGIN_MS = 5_000;
/** How long one tool call waits for a purchase: under the 60 s that MCP clients often allow. */
const WAIT_MS = 45_000;

export const QuoteInput = {
  workload: z
    .enum(["image", "fractal"])
    .default("image")
    .describe("image: a picture made on a GPU. fractal: a CPU render."),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe("For an image: what to draw, at most 300 characters."),
  size: z
    .union([z.literal(768), z.literal(1024)])
    .default(1024)
    .describe("For an image: 768 or 1024 pixels square."),
  steps: z.number().int().min(1).max(4).default(4).describe("For an image: 1 to 4 steps."),
  seed: z
    .number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional()
    .describe("For an image: a seed, for a repeatable image."),
  preset: z
    .enum(["hd-fast", "hd-heavy"])
    .default("hd-fast")
    .describe("For a fractal: hd-fast (1280x720) or hd-heavy (1920x1080)."),
  deadlineSec: z
    .number()
    .int()
    .min(5)
    .max(120)
    .default(60)
    .describe("The job must finish within this many seconds, 5 to 120."),
  gpu: z.boolean().optional().describe("Require a GPU. Images default to yes."),
  minVramGb: z
    .number()
    .positive()
    .max(1024)
    .optional()
    .describe("The least GPU memory, in GB. Images default to 16."),
  budgetUsd: z
    .number()
    .positive()
    .max(1000)
    .optional()
    .describe(
      "The budget your human gave for this job, in USD. Leave it out when they gave none: then ask them before buying.",
    ),
  runId: z
    .string()
    .regex(ID)
    .optional()
    .describe("To continue a task: the runId an earlier pekkah_quote returned."),
};
const QuoteArgs = z.object(QuoteInput);
export type QuoteArgs = z.input<typeof QuoteArgs>;

export const BuyInput = {
  offerId: z.string().regex(ID).describe("An offerId that pekkah_quote returned."),
  maxUsd: z
    .number()
    .positive()
    .max(0.1)
    .describe("The most my agent commits to pay for this job, in USD. At most 0.10."),
  escrow: z
    .boolean()
    .optional()
    .describe(
      "Lock the payment in Masumi escrow. Defaults to yes when the worker sells through escrow.",
    ),
  overBudgetApproved: z
    .boolean()
    .default(false)
    .describe(
      "true only when your human said yes to this price after you told them it is above their budget.",
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe("Why my agent buys this offer, in one or two plain sentences. The market shows it."),
};
const BuyArgs = z.object(BuyInput);
export type BuyArgs = z.input<typeof BuyArgs>;

export const ResultInput = {
  runId: z.string().regex(ID).describe("The runId of a purchase."),
};

export interface ShopDeps extends Omit<Deps, "buyer"> {
  buyer: Pick<Buyer, "buy" | "idle" | "balance">;
  /** The per-payment cap (CAP_PER_PAYMENT_USD). */
  capUsd: number;
  /** Who started the run, for the market's page, e.g. "Claude via MCP". */
  client: () => string;
  /** Where the full PNGs are saved (PEKKAH_OUTPUT_DIR); not saved without it. */
  outputDir?: string;
  now?: () => number;
  waitMs?: number;
  /** Local wall-clock time for POSIX milliseconds. */
  clock?: (posixMs: number) => string;
}

interface Quoted {
  runId: string;
  offer: Offer | CounterOffer;
  /** Exactly what the market quoted: an escrow lock commits to it. */
  request: ComputeRequest;
  /** The budget this quote was made under; undefined when my human gave none. */
  budgetUsd?: number;
  escrowSeller: boolean;
}

interface Paid {
  jobId: string;
  workerId: string;
  txHash: string;
  amountAtomic: string;
  escrow: boolean;
  resultUrl: string;
  mime?: string;
  durationMs?: number;
  sha256?: string;
}

type Outcome = { ok: true; paid: Paid } | { ok: false; reason: string };

interface Task {
  runId: string;
  budgetUsd?: number;
  purchase?: { offerId: string; done: Promise<Outcome>; outcome?: Outcome };
  ended: boolean;
}

const text = (t: string): ToolResult["content"][number] => ({ type: "text", text: t });
const fail = (t: string): ToolResult => ({ content: [text(t)], isError: true });

/** The refusal that makes my agent ask, even when the model skipped the skill. */
export function overBudgetRefusal(budgetUsd: number, priceAtomic: string): string {
  return `This is above the ${formatUsd(budgetUsd)} budget your human gave. Ask them first. If they say yes to ${formatUsdAtomic(priceAtomic)}, call pekkah_buy again with overBudgetApproved: true. Nothing was bought.`;
}

export const NO_BUDGET_REFUSAL =
  "Your human gave no budget for this job. Ask them for one, then call pekkah_quote again with budgetUsd and this runId. Nothing was bought.";

function defaultClock(posixMs: number): string {
  return new Date(posixMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function relative(ms: number, now: number): string {
  const min = Math.round((ms - now) / 60_000);
  if (min === 0) return "now";
  return min > 0 ? `in ${min} min` : `${-min} min ago`;
}

function buildRequest(a: z.output<typeof QuoteArgs>, budgetUsd: number): ComputeRequest | string {
  const image = a.workload === "image";
  if (image && !a.prompt) return "An image needs a prompt.";
  const gpu = a.gpu ?? image;
  const minVramGb = a.minVramGb ?? (image ? 16 : undefined);
  const parsed = ComputeRequest.safeParse({
    workload: a.workload,
    params: image
      ? {
          prompt: a.prompt,
          seed: a.seed ?? Math.floor(Math.random() * 4_294_967_295),
          size: a.size,
          steps: a.steps,
        }
      : { preset: a.preset },
    constraints: {
      ...(gpu ? { gpu: true } : {}),
      ...(minVramGb !== undefined ? { minVramGb } : {}),
      deadlineSec: a.deadlineSec,
    },
    budget: { maxUsd: budgetUsd },
  });
  if (!parsed.success) {
    return `Not a valid request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
  }
  return parsed.data;
}

function hardwareText(w: WorkerSnapshot | undefined): string {
  if (!w) return "";
  const h = w.hardware;
  const hw = h.gpu
    ? `${h.gpu.name}, ${h.gpu.vramGb} GB VRAM, ${h.vcpus} vCPU`
    : `${h.vcpus} vCPU, ${h.memGb} GB RAM`;
  return `${hw} (reported by the machine)`;
}

/** The quote as my agent reads it, ending with the one-line hint. */
export function quoteText(
  quote: Quote,
  o: { runId: string; budgetUsd?: number; workers: WorkerSnapshot[]; now: number },
): string {
  const byId = new Map(o.workers.map((w) => [w.workerId, w]));
  const offerLine = (x: Offer | CounterOffer) => {
    const w = byId.get(x.workerId);
    const left = Math.max(0, Math.round((Date.parse(x.expiresAt) - o.now) / 1000));
    const hw = hardwareText(w);
    return [
      `offerId ${x.offerId}: worker ${x.workerId}${hw ? `, ${hw}` : ""}`,
      `${formatUsdAtomic(x.priceAtomic)}`,
      `about ${Math.round(x.estSec)} s (estimated from the market's measurements)`,
      `valid ${left} s more`,
      w?.escrowSeller ? "Masumi escrow available" : "no escrow (paid directly)",
    ].join(" · ");
  };
  const r = quote.request;
  const what =
    r.workload === "image"
      ? `an image, ${r.params.size}x${r.params.size}, ${r.params.steps} steps: "${r.params.prompt}"`
      : `a CPU render, preset ${r.params.preset}`;
  const lines = [
    `Quote for task ${o.runId}. Quotes are free: nothing was bought.`,
    `Request: ${what}; ${r.constraints.gpu ? `GPU${r.constraints.minVramGb ? ` with at least ${r.constraints.minVramGb} GB` : ""}, ` : ""}deadline ${r.constraints.deadlineSec} s.`,
    `Budget: ${o.budgetUsd === undefined ? "none given yet" : formatUsd(o.budgetUsd)}.`,
    quote.offers.length
      ? `Offers within ${o.budgetUsd === undefined ? "my agent's cap" : "the budget"}:\n${quote.offers.map((x) => `- ${offerLine(x)}`).join("\n")}`
      : "Offers within the budget: none.",
  ];
  if (quote.counterOffer) {
    lines.push(
      `Counter-offer: ${offerLine(quote.counterOffer)}.\nThe market says: ${quote.counterOffer.reason}`,
    );
  }
  lines.push(
    `Market price: ${quote.marketPriceUsd === null ? "none (no worker can do it now)" : formatUsd(quote.marketPriceUsd)}.`,
  );
  const counterId = quote.counterOffer?.workerId;
  const rejected = quote.rejected.filter(
    (x) => !(x.workerId === counterId && x.reason === "over_budget"),
  );
  if (rejected.length) {
    lines.push(`Rejected:\n${rejected.map((x) => `- ${x.workerId}: ${x.detail}`).join("\n")}`);
  }
  lines.push(`Hint: ${hint(quote, o.budgetUsd)}`);
  return lines.join("\n");
}

function hint(quote: Quote, budgetUsd: number | undefined): string {
  const best = quote.offers[0];
  if (budgetUsd === undefined) {
    const cheapest = best ?? quote.counterOffer;
    return cheapest
      ? `no budget given: ask your human for one before buying (the cheapest is ${formatUsdAtomic(cheapest.priceAtomic)} on worker ${cheapest.workerId}).`
      : "no worker can do this job now.";
  }
  if (best) {
    return `fits the budget: offerId ${best.offerId}, ${formatUsdAtomic(best.priceAtomic)} on worker ${best.workerId}. Buy it without asking.`;
  }
  const c = quote.counterOffer;
  if (c) {
    return `nothing within ${formatUsd(budgetUsd)}: ask your human before paying ${formatUsdAtomic(c.priceAtomic)} (worker ${c.workerId}).`;
  }
  return "no worker can do this job now.";
}

function isType<T extends JobEvent["type"]>(type: T) {
  return (e: JobEvent): e is EventOf<T> => e.type === type;
}

function lastOf<T extends JobEvent["type"]>(
  events: readonly JobEvent[],
  type: T,
): EventOf<T> | undefined {
  return events.filter(isType(type)).at(-1);
}

/** Masumi escrow, step by step, from the events the market recorded for the run (rule 4). */
export function escrowLines(
  events: readonly JobEvent[],
  o: { now: number; clock: (posixMs: number) => string },
): string[] {
  const lock = lastOf(events, "escrow.locked");
  if (!lock) return ["Masumi escrow: the market hasn't recorded the lock yet."];
  const d = lock.data;
  const forLock = <E extends { data: { lockTxHash: string } }>(list: E[]) =>
    list.find((e) => e.data.lockTxHash === d.txHash);
  const submitted = forLock(events.filter(isType("escrow.result_submitted")));
  const released = forLock(events.filter(isType("escrow.released")));
  const refunded = forLock(events.filter(isType("escrow.refunded")));
  const delivered = lastOf(events, "job.completed");
  const unlock = Number(d.unlockTime);
  const lines = [
    `1. Locked in escrow: ${formatAtomic(d.amountAtomic)} tUSDM plus ${formatLovelace(d.collateralLovelace)} of collateral. Tx: ${d.explorerUrl}`,
    submitted
      ? `2. Result hash submitted on chain${delivered && submitted.data.resultHash === delivered.data.sha256 ? ", and it matches the delivered result" : ""}. Tx: ${submitted.data.explorerUrl}`
      : `2. Result hash: not submitted yet (due by ${o.clock(Number(d.submitResultTime))}).`,
    `3. Unlock: ${o.clock(unlock)} (${relative(unlock, o.now)}).`,
    released
      ? `4. Released to the seller: Tx ${released.data.explorerUrl}. The buyer's ${formatLovelace(released.data.collateralReturnLovelace)} of collateral came back.`
      : refunded
        ? `4. Refunded to the buyer: Tx ${refunded.data.explorerUrl}.`
        : "4. Waiting for the unlock: then the seller can collect.",
    `Status: ${released ? MASUMI_RELEASED_LABEL : refunded ? MASUMI_REFUNDED_LABEL : MASUMI_LOCK_LABEL}`,
  ];
  return lines;
}

export class Shop {
  private readonly tasks = new Map<string, Task>();
  private readonly offers = new Map<string, Quoted>();

  constructor(private readonly deps: ShopDeps) {}

  private get f(): typeof fetch {
    return this.deps.fetch ?? fetch;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private readonly emit: NonNullable<Deps["emit"]> = (type, data, ids) =>
    this.deps.emit ? this.deps.emit(type, data, ids) : Promise.resolve();

  /** pekkah_quote: free. The first quote of a task starts its run on the market's page. */
  async quote(input: QuoteArgs): Promise<ToolResult> {
    const a = QuoteArgs.parse(input);
    let task: Task | undefined;
    if (a.runId) {
      task = this.tasks.get(a.runId);
      if (!task) {
        return fail(
          `No task with runId "${a.runId}" since this server started. Quote again without runId.`,
        );
      }
      if (task.purchase) {
        return fail(
          `Task ${a.runId} already has a purchase. Call pekkah_result with it, or quote again without runId for a new task.`,
        );
      }
      if (task.ended) {
        return fail(`Task ${a.runId} is closed. Quote again without runId for a new task.`);
      }
    }
    const budgetUsd = a.budgetUsd ?? task?.budgetUsd;
    // Without a budget the market quotes up to my agent's cap; buying still needs a budget.
    const request = buildRequest(a, budgetUsd ?? this.deps.capUsd);
    if (typeof request === "string") return fail(request);

    if (!task) {
      await this.closeOpenTasks();
      task = { runId: this.deps.newRunId(), ended: false };
      this.tasks.set(task.runId, task);
      await this.emit(
        "run.started",
        { scenario: "custom", client: this.deps.client(), request },
        { runId: task.runId },
      );
      const balance = await this.deps.buyer.balance().catch(() => null);
      if (balance) await this.emit("agent.balance", balance, { runId: task.runId });
    }
    if (budgetUsd !== undefined) task.budgetUsd = budgetUsd;

    const [quote, workers] = await Promise.all([
      this.fetchQuote(request, task.runId),
      this.workers(),
    ]);
    if (typeof quote === "string") return fail(quote);
    this.remember(quote, task.runId, budgetUsd, workers);
    return {
      content: [
        text(
          quoteText(quote, {
            runId: task.runId,
            ...(budgetUsd !== undefined ? { budgetUsd } : {}),
            workers,
            now: this.now(),
          }),
        ),
      ],
    };
  }

  /**
   * pekkah_buy: refuses at once what my agent may not buy; otherwise starts the purchase in the
   * background and returns its runId.
   */
  buy(input: BuyArgs): { refused: ToolResult } | { runId: string } {
    const a = BuyArgs.parse(input);
    const quoted = this.offers.get(a.offerId);
    if (!quoted) {
      return {
        refused: fail(
          `My agent didn't quote offer ${a.offerId}, so it won't buy it. Call pekkah_quote first. Nothing was bought.`,
        ),
      };
    }
    const task = this.tasks.get(quoted.runId);
    if (!task) return { refused: fail("That offer's task is gone. Quote again.") };
    if (task.purchase) {
      if (task.purchase.offerId === a.offerId) return { runId: task.runId };
      return {
        refused: fail(
          `Task ${task.runId} already bought offer ${task.purchase.offerId}. Call pekkah_result with runId "${task.runId}".`,
        ),
      };
    }
    if (task.ended) return { refused: fail(`Task ${task.runId} is closed. Quote again.`) };
    const refusal = this.refusal(quoted, a.maxUsd, a.overBudgetApproved);
    if (refusal) return { refused: fail(refusal) };
    const escrow = a.escrow ?? quoted.escrowSeller;
    if (escrow && !quoted.escrowSeller) {
      return {
        refused: fail(
          `Worker ${quoted.offer.workerId} doesn't sell through Masumi escrow. Buy without escrow, or pick another offer. Nothing was bought.`,
        ),
      };
    }
    const done = this.purchase(task, quoted, { ...a, escrow }).catch(
      (err: unknown): Outcome => ({
        ok: false,
        reason: `Pekkah failed: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    const purchase: NonNullable<Task["purchase"]> = { offerId: a.offerId, done };
    void done.then((outcome) => {
      purchase.outcome = outcome;
    });
    task.purchase = purchase;
    return { runId: task.runId };
  }

  /** pekkah_result: the purchase's outcome, with the escrow's current state read from the market. */
  async result(
    runId: string,
    tick?: (waitedSec: number) => Promise<void>,
  ): Promise<ToolResult | null> {
    const task = this.tasks.get(runId);
    if (task && !task.purchase) {
      return fail(
        `Nothing is bought yet in task ${runId}. Buy an offer with pekkah_buy, or quote again.`,
      );
    }
    if (task?.purchase) {
      const outcome = task.purchase.outcome ?? (await this.wait(task.purchase.done, tick));
      if (!outcome) return null;
      if (!outcome.ok) return fail(outcome.reason);
      return this.render(runId, outcome.paid);
    }
    // Not bought by this server (or before a restart): the market keeps the last 30 runs.
    const log = await this.runLog(runId);
    if (!log) return fail(`The market has no run "${runId}" (it keeps the last 30 runs).`);
    const paid = paidFromEvents(log.events);
    if (!paid) {
      return {
        content: [text(`Run ${runId} has no receipt yet: nothing has been paid or locked in it.`)],
      };
    }
    return this.render(runId, paid, log.events);
  }

  // ---------------------------------------------------------------------------------------------

  private refusal(q: Quoted, maxUsd: number, approved: boolean): string | null {
    const price = q.offer.priceAtomic;
    if (compareAtomic(usdToAtomic(maxUsd), usdToAtomic(this.deps.capUsd)) > 0) {
      return `maxUsd ${formatUsd(maxUsd)} is above my agent's cap of ${formatUsd(this.deps.capUsd)} per payment. Nothing was bought.`;
    }
    if (compareAtomic(price, usdToAtomic(maxUsd)) > 0) {
      return `Offer ${q.offer.offerId} costs ${formatUsdAtomic(price)}, above the ${formatUsd(maxUsd)} ceiling in maxUsd. Nothing was bought.`;
    }
    if (q.budgetUsd === undefined) return NO_BUDGET_REFUSAL;
    if (compareAtomic(price, usdToAtomic(q.budgetUsd)) > 0 && !approved) {
      return overBudgetRefusal(q.budgetUsd, price);
    }
    return null;
  }

  private async purchase(
    task: Task,
    first: Quoted,
    a: z.output<typeof BuyArgs> & { escrow: boolean },
  ): Promise<Outcome> {
    const started = this.now();
    const ids = { runId: task.runId };
    const end = async (outcome: Outcome): Promise<Outcome> => {
      task.ended = true;
      if (outcome.ok) {
        const p = outcome.paid;
        await this.emit(
          "run.completed",
          { jobId: p.jobId, workerId: p.workerId, txHash: p.txHash, totalMs: this.now() - started },
          { ...ids, jobId: p.jobId },
        );
      } else {
        await this.emit("run.failed", { reason: outcome.reason }, ids);
      }
      return outcome;
    };

    let quoted = first;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const expired = this.now() >= Date.parse(quoted.offer.expiresAt) - EXPIRY_MARGIN_MS;
      if (attempt === 2 || expired) {
        const reason = `The offer from worker ${first.offer.workerId} ${expired ? "expired" : "was no longer available"} before payment; nothing was charged. Asking again for the same job from the same worker.`;
        await this.emit("agent.reroute", { excluded: [], reason }, ids);
        const again = await this.requote(task, first, a.maxUsd, a.overBudgetApproved);
        if (typeof again === "string") return end({ ok: false, reason: again });
        quoted = again;
      }
      const o = quoted.offer;
      const over =
        quoted.budgetUsd !== undefined &&
        compareAtomic(o.priceAtomic, usdToAtomic(quoted.budgetUsd)) > 0;
      await this.emit(
        "agent.decision",
        {
          kind: o.kind,
          chosen: o,
          reasons: [a.reason],
          ...(over && quoted.budgetUsd !== undefined
            ? { overBudget: { budgetUsd: quoted.budgetUsd, priceUsd: o.priceUsd } }
            : {}),
        },
        ids,
      );
      const expect: PaymentExpectation = a.escrow
        ? {
            transferMethod: "masumi",
            payTo: masumiEscrowAddress(NETWORK),
            seller: o.payTo,
            parameters: quoted.request,
            amountAtomic: o.priceAtomic,
            asset: o.asset,
          }
        : { payTo: o.payTo, amountAtomic: o.priceAtomic, asset: o.asset };
      await this.deps.buyer.idle();
      const bought = await this.deps.buyer.buy({
        url: `${this.deps.marketUrl}/api/${a.escrow ? "escrow-jobs" : "jobs"}/${o.offerId}`,
        headers: { [RUN_ID_HEADER]: task.runId },
        expect,
        runId: task.runId,
        offerId: o.offerId,
      });
      if (OFFER_GONE.has(bought.status) && !bought.txHash && attempt === 1) continue;

      const body = JobResultBody.safeParse(bought.body);
      if (bought.status === 200 && bought.settle?.success && body.success) {
        const job = body.data;
        return end({
          ok: true,
          paid: {
            jobId: job.jobId,
            workerId: job.workerId,
            txHash: job.txHash,
            amountAtomic: o.priceAtomic,
            escrow: a.escrow,
            resultUrl: job.resultUrl,
            mime: job.mime,
            durationMs: job.durationMs,
            sha256: job.sha256,
          },
        });
      }
      return end({
        ok: false,
        reason:
          bought.status === 502
            ? `The job failed on worker ${o.workerId}. The payment was cancelled: nothing was charged.`
            : bought.status === 402 && bought.txHash
              ? `The ${a.escrow ? "escrow lock" : "payment"} didn't land (tx ${bought.txHash}); the market keeps the result until it does.`
              : `The market answered ${bought.status}; nothing was bought.`,
      });
    }
    return end({
      ok: false,
      reason: "The offer kept expiring before payment; nothing was charged.",
    });
  }

  /** The same request again, bought only from the same worker, under the same rules. */
  private async requote(
    task: Task,
    first: Quoted,
    maxUsd: number,
    approved: boolean,
  ): Promise<Quoted | string> {
    const [quote, workers] = await Promise.all([
      this.fetchQuote(first.request, task.runId),
      this.workers(),
    ]);
    if (typeof quote === "string") return quote;
    this.remember(quote, task.runId, first.budgetUsd, workers);
    const same = [...quote.offers, ...(quote.counterOffer ? [quote.counterOffer] : [])].find(
      (x) => x.workerId === first.offer.workerId,
    );
    if (!same) {
      return `Worker ${first.offer.workerId} no longer offers this job; nothing was charged. Quote again.`;
    }
    const again = this.offers.get(same.offerId) as Quoted;
    const refusal = this.refusal(again, maxUsd, approved);
    if (refusal) return refusal;
    if (
      approved &&
      first.budgetUsd !== undefined &&
      compareAtomic(same.priceAtomic, usdToAtomic(first.budgetUsd)) > 0 &&
      compareAtomic(same.priceAtomic, first.offer.priceAtomic) > 0
    ) {
      return `Worker ${same.workerId} now asks ${formatUsdAtomic(same.priceAtomic)}, more than the ${formatUsdAtomic(first.offer.priceAtomic)} your human approved. Nothing was bought: ask them again.`;
    }
    return again;
  }

  /** A new task closes the open ones that never bought anything. */
  private async closeOpenTasks(): Promise<void> {
    for (const task of this.tasks.values()) {
      if (task.ended || task.purchase) continue;
      task.ended = true;
      await this.emit(
        "run.failed",
        { reason: "My agent didn't buy: it moved on to a new request." },
        { runId: task.runId },
      );
    }
  }

  private remember(
    quote: Quote,
    runId: string,
    budgetUsd: number | undefined,
    workers: WorkerSnapshot[],
  ): void {
    const seller = new Set(workers.filter((w) => w.escrowSeller).map((w) => w.workerId));
    for (const offer of [...quote.offers, ...(quote.counterOffer ? [quote.counterOffer] : [])]) {
      this.offers.set(offer.offerId, {
        runId,
        offer,
        request: quote.request,
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        escrowSeller: seller.has(offer.workerId),
      });
    }
  }

  private async fetchQuote(request: ComputeRequest, runId: string): Promise<Quote | string> {
    const res = await this.f(`${this.deps.marketUrl}/api/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", [RUN_ID_HEADER]: runId },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return `The market refused the quote (HTTP ${res.status}).`;
    const quote = Quote.safeParse(await res.json());
    return quote.success ? quote.data : "The market's quote didn't match the protocol.";
  }

  private async workers(): Promise<WorkerSnapshot[]> {
    try {
      const res = await this.f(`${this.deps.marketUrl}/api/workers`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return [];
      const parsed = z.array(WorkerSnapshot).safeParse(await res.json());
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  private async runLog(runId: string): Promise<RunLog | null> {
    try {
      const res = await this.f(`${this.deps.marketUrl}/api/runs/${runId}/events`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const parsed = RunLog.safeParse(await res.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async wait(
    done: Promise<Outcome>,
    tick?: (waitedSec: number) => Promise<void>,
  ): Promise<Outcome | null> {
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
          timer = setTimeout(() => resolve(null), this.deps.waitMs ?? WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearInterval(ticker);
    }
  }

  /** The image, the receipt and, for escrow, every step the market has seen so far. */
  private async render(
    runId: string,
    paid: Paid,
    known?: readonly JobEvent[],
  ): Promise<ToolResult> {
    const resultUrl = `${this.deps.marketUrl}${paid.resultUrl}`;
    const worker = `worker ${paid.workerId}`;
    const lines = [
      paid.escrow
        ? `Locked ${formatUsdAtomic(paid.amountAtomic)} in test tUSDM in Masumi escrow, with ${worker} as the seller, after the job delivered. Lock transaction: ${explorerTxUrl(paid.txHash)}`
        : `Paid ${formatUsdAtomic(paid.amountAtomic)} in test tUSDM to ${worker}, the worker that ran the job, after it delivered. Transaction: ${explorerTxUrl(paid.txHash)}`,
      `Made${paid.durationMs !== undefined ? ` in ${(paid.durationMs / 1000).toFixed(1)} s` : ""} on ${worker}. Full result: ${resultUrl}${paid.sha256 ? ` (sha256 ${paid.sha256})` : ""}.`,
    ];
    if (paid.escrow) {
      const events = (await this.runLog(runId))?.events ?? known ?? [];
      lines.push(
        "Masumi escrow, as the market has seen it:",
        ...escrowLines(events, { now: this.now(), clock: this.deps.clock ?? defaultClock }),
      );
    }
    lines.push(`Task: ${runId}. Cardano preprod: test tokens, no real money.`);

    // Paid by now: whatever happens to the download, the receipt goes back.
    let image: ToolResult["content"][number] | undefined;
    try {
      const res = await this.f(resultUrl, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        lines.push(`(The result couldn't be fetched: HTTP ${res.status}.)`);
      } else {
        const bytes = Buffer.from(await res.arrayBuffer());
        const png = (paid.mime ?? res.headers.get("content-type") ?? "").startsWith("image/png");
        if (png && this.deps.outputDir) {
          const file = join(this.deps.outputDir, `pekkah-${runId}.png`);
          try {
            mkdirSync(this.deps.outputDir, { recursive: true });
            writeFileSync(file, bytes);
            lines.push(`Saved the full PNG to ${file}`);
          } catch (err) {
            lines.push(
              `(The PNG couldn't be saved: ${err instanceof Error ? err.message : String(err)}.)`,
            );
          }
        }
        // MCP clients drop large results, so the image travels as a JPEG; the PNG stays linked.
        if (png) {
          image = {
            type: "image",
            data: pngToJpeg(bytes).toString("base64"),
            mimeType: "image/jpeg",
          };
        }
      }
    } catch (err) {
      lines.push(
        `(The result couldn't be fetched: ${err instanceof Error ? err.message : String(err)}.)`,
      );
    }
    return { content: [...(image ? [image] : []), text(lines.join("\n"))] };
  }
}

/** A paid or locked run's receipt, from the events the market recorded. */
function paidFromEvents(events: readonly JobEvent[]): Paid | null {
  const receipt = lastOf(events, "receipt.issued");
  if (!receipt?.data.resultUrl) return null;
  const r = receipt.data.receipt;
  const done = events
    .filter(isType("job.completed"))
    .reverse()
    .find((e) => !receipt.jobId || e.jobId === receipt.jobId);
  return {
    jobId: receipt.jobId ?? done?.jobId ?? "",
    workerId: done?.data.workerId ?? "?",
    txHash: r.txHash,
    amountAtomic: r.amountAtomic,
    escrow: r.transferMethod === "masumi",
    resultUrl: receipt.data.resultUrl,
    ...(done?.data.mime ? { mime: done.data.mime } : {}),
    ...(done ? { durationMs: done.data.durationMs, sha256: done.data.sha256 } : {}),
  };
}
