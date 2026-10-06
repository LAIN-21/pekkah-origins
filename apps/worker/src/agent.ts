import { createHash } from "node:crypto";
import {
  HEARTBEAT_BUSY_MS,
  HEARTBEAT_MS,
  type JobDispatchMsg,
  MarketToWorker,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  type WorkerToMarket,
  type WorkerUtil,
  type WorkloadName,
  WS_MAX_PAYLOAD_BYTES,
} from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import WebSocket from "ws";
import { boundHello, type HelloFields } from "./hello.js";
import type { Workload } from "./workloads/index.js";

/** Refusals that a reconnect can't fix: the worker stops instead of retrying forever. */
export const FATAL_REFUSALS = new Set(["unauthorized", "invalid_hello"]);

export interface Refusal {
  code: string;
  message: string;
}

export interface WorkerAgentOptions {
  url: string;
  /** Built again before every connect, so the hardware report is fresh each time. */
  hello: () => Promise<HelloFields>;
  workloads: Workload[];
  sampleUtil: () => Promise<WorkerUtil>;
  log: Logger;
  /** Called once when the market refuses this worker for good. The agent has stopped by then. */
  onRefused?: (refusal: Refusal) => void;
}

/** The worker side of /ws/worker (PLAN 5.3): it dials out, so it needs no inbound port. */
export class WorkerAgent {
  private socket: WebSocket | null = null;
  private warm: WorkloadName[] = [];
  private job: { jobId: string; abort: AbortController } | null = null;
  private backoff = RECONNECT_INITIAL_MS;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private warmTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly o: WorkerAgentOptions) {}

  start(): void {
    void this.refreshWarm().finally(() => void this.connect());
    this.warmTimer = setInterval(() => void this.refreshWarm(), 5_000);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.warmTimer);
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    this.job?.abort.abort("worker stopping");
    this.socket?.close(1001, "worker stopping");
  }

  private retry(): void {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let hello: HelloFields;
    try {
      hello = boundHello(await this.o.hello());
    } catch (err) {
      this.o.log.error({ err: err instanceof Error ? err.message : String(err) }, "no hello");
      return this.retry();
    }
    if (this.stopped) return;
    const ws = new WebSocket(this.o.url, {
      maxPayload: WS_MAX_PAYLOAD_BYTES,
      handshakeTimeout: 10_000,
    });
    this.socket = ws;
    ws.on("open", () => {
      this.backoff = RECONNECT_INITIAL_MS;
      this.o.log.info({ url: this.o.url, warm: this.warm }, "connected to the market");
      this.send({ type: "hello", ...hello, warm: this.warm });
      this.scheduleHeartbeat();
    });
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("error", (err) => this.o.log.warn({ err: err.message }, "market connection error"));
    ws.on("close", (code, reason) => {
      if (this.socket === ws) this.socket = null;
      clearTimeout(this.heartbeatTimer);
      // Nobody can receive this job's result any more; the market fails it on its side.
      this.job?.abort.abort("market connection lost");
      const why = reason.toString();
      // The market sends an error message, then closes with its code as the reason.
      if (code === 1008 && FATAL_REFUSALS.has(why)) this.refused({ code: why, message: why });
      if (this.stopped) return;
      this.o.log.warn({ code, reason: why, retryInMs: this.backoff }, "disconnected");
      this.retry();
    });
  }

  private refused(refusal: Refusal): void {
    if (this.stopped) return;
    this.o.log.error(refusal, "the market refused this worker; not reconnecting");
    this.stop();
    this.o.onRefused?.(refusal);
  }

  private send(msg: WorkerToMarket): boolean {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  private scheduleHeartbeat(): void {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(
      async () => {
        await this.heartbeat();
        this.scheduleHeartbeat();
      },
      this.job ? HEARTBEAT_BUSY_MS : HEARTBEAT_MS,
    );
  }

  private async heartbeat(): Promise<void> {
    const util = await this.o.sampleUtil().catch(() => ({ cpuPct: 0 }));
    this.send({
      type: "heartbeat",
      busy: this.job !== null,
      ...(this.job ? { currentJobId: this.job.jobId } : {}),
      util,
      warm: this.warm,
    });
  }

  /** A workload is offered only while it is ready (section 8). */
  private async refreshWarm(): Promise<void> {
    const warm: WorkloadName[] = [];
    for (const workload of this.o.workloads) {
      if (await workload.ready().catch(() => false)) warm.push(workload.name);
    }
    if (warm.join() !== this.warm.join()) {
      this.o.log.info({ warm }, "warm workloads changed");
      this.warm = warm;
      if (this.socket) await this.heartbeat();
    }
  }

  private onMessage(raw: string): void {
    let parsed: ReturnType<typeof MarketToWorker.safeParse>;
    try {
      parsed = MarketToWorker.safeParse(JSON.parse(raw));
    } catch {
      this.o.log.warn("unreadable message from the market");
      return;
    }
    if (!parsed.success) {
      this.o.log.warn(
        { issues: parsed.error.issues.slice(0, 3) },
        "invalid message from the market",
      );
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case "welcome":
        this.o.log.info({ workerId: msg.workerId }, "welcomed by the market");
        break;
      case "job.dispatch":
        void this.runJob(msg);
        break;
      case "job.cancel":
        if (this.job?.jobId === msg.jobId) this.job.abort.abort(msg.reason);
        break;
      case "error":
        if (FATAL_REFUSALS.has(msg.code)) this.refused({ code: msg.code, message: msg.message });
        else this.o.log.error({ code: msg.code, message: msg.message }, "the market refused me");
        break;
    }
  }

  private fail(jobId: string, error: string, durationMs = 0): void {
    this.send({ type: "job.result", jobId, ok: false, error: error.slice(0, 2000), durationMs });
  }

  private async runJob(msg: JobDispatchMsg): Promise<void> {
    if (this.job) return this.fail(msg.jobId, "busy");
    const workload = this.o.workloads.find((w) => w.name === msg.workload);
    if (!workload || !this.warm.includes(msg.workload)) {
      return this.fail(msg.jobId, `workload ${msg.workload} is not ready here`);
    }
    let params: unknown;
    try {
      params = workload.validate(msg.params);
    } catch {
      return this.fail(msg.jobId, "invalid params");
    }

    const abort = new AbortController();
    this.job = { jobId: msg.jobId, abort };
    this.send({ type: "job.accepted", jobId: msg.jobId });
    await this.heartbeat();
    this.scheduleHeartbeat();
    const started = performance.now();
    let lastPct = -1;
    let lastSent = 0;
    const log = this.o.log.child({ jobId: msg.jobId, workload: msg.workload, kind: msg.kind });
    log.info("job started");
    try {
      const out = await workload.run({
        jobId: msg.jobId,
        kind: msg.kind,
        params,
        deadlineSec: msg.deadlineSec,
        signal: abort.signal,
        log,
        progress: (pct, note) => {
          const now = Date.now();
          if (pct === lastPct || (now - lastSent < 400 && pct < 100)) return;
          lastPct = pct;
          lastSent = now;
          this.send({ type: "job.progress", jobId: msg.jobId, pct, ...(note ? { note } : {}) });
        },
      });
      const durationMs = Math.round(performance.now() - started);
      this.send({
        type: "job.result",
        jobId: msg.jobId,
        ok: true,
        mime: out.mime,
        sha256: createHash("sha256").update(out.data).digest("hex"),
        bytes: out.data.length,
        dataBase64: out.data.toString("base64"),
        durationMs,
      });
      log.info({ durationMs, bytes: out.data.length }, "job delivered");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ error: message }, "job failed");
      this.fail(msg.jobId, message, Math.round(performance.now() - started));
    } finally {
      this.job = null;
      await this.heartbeat();
      this.scheduleHeartbeat();
    }
  }
}
