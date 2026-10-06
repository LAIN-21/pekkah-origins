import { createHash, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import {
  type Calibration,
  type FractalParams,
  HelloMsg,
  type ImageParams,
  type JobKind,
  RESULT_WAIT_GRACE_SEC,
  usdToAtomic,
  WORKER_SILENT_MS,
  type WorkerHardware,
  type WorkerPrice,
  type WorkerSnapshot,
  type WorkerStatus,
  WorkerToMarket,
  type WorkerUtil,
  type WorkloadName,
  WS_MAX_PAYLOAD_BYTES,
} from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import { monotonicFactory } from "ulid";
import { type WebSocket, WebSocketServer } from "ws";
import type { EventBus } from "./events.js";
import { pngSize } from "./png.js";

const nextJobId = monotonicFactory();
const HELLO_TIMEOUT_MS = 10_000;

export type DispatchRequest = (
  | { workload: "fractal"; params: FractalParams }
  | { workload: "image"; params: ImageParams }
) & {
  kind: JobKind;
  deadlineSec: number;
  /** Chosen by the caller when it must know the id before dispatch (paid jobs). */
  jobId?: string;
  runId?: string;
  offerId?: string;
  txHash?: string;
  estSec?: number;
  /** Events marked dev: true (from /api/dev/* routes); never shown as runs. */
  dev?: boolean;
  /** No job events (calibration reports through worker.calibrated). */
  quiet?: boolean;
};

export type JobOutcome =
  | {
      ok: true;
      jobId: string;
      workerId: string;
      mime: string;
      sha256: string;
      data: Buffer;
      /** Dispatch to result, measured by the market. */
      durationMs: number;
      workerDurationMs: number;
      /** The market's own check of an image result. */
      check?: { kind: "png"; width: number; height: number };
    }
  | { ok: false; jobId: string; workerId: string; error: string; durationMs: number };

/** Who decided a job's outcome: the worker's own report, or the market. */
type Decider = "worker" | "market";

interface PendingJob {
  jobId: string;
  request: DispatchRequest;
  startedAt: number;
  timer: NodeJS.Timeout;
  resolve: (outcome: JobOutcome) => void;
}

interface WorkerEntry {
  workerId: string;
  name: string;
  payTo: string;
  hardware: WorkerHardware;
  prices: WorkerPrice[];
  schedule?: string;
  version: string;
  socket: WebSocket | null;
  lastSeenAt: Date;
  warm: WorkloadName[];
  util?: WorkerUtil;
  busy: boolean;
  currentJobId?: string;
  calibration: Calibration;
  calibrating: number;
  untrusted: boolean;
  /** The market sells its compute (allowlisted). False means probation (PR-17). */
  selling: boolean;
  /** Workloads calibrated, or being calibrated, on this connection. */
  calibrated: Set<WorkloadName>;
  pending: PendingJob | null;
  silence?: NodeJS.Timeout;
}

export interface WorkerRegistryOptions {
  /** WORKER_TOKENS: workerId → token. */
  tokens: Map<string, string>;
  bus: EventBus;
  log: Logger;
  /** Called when a workload needs calibrating (on hello, and when it first turns warm). */
  calibrate?: (registry: WorkerRegistry, workerId: string, workload: WorkloadName) => void;
  silentMs?: number;
  /** The Masumi seller's address, while Masumi is on: that worker can sell through escrow. */
  escrowSeller?: string;
}

export function parseWorkerTokens(value: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const pair of value.split(",")) {
    const i = pair.indexOf(":");
    if (i <= 0) continue;
    const id = pair.slice(0, i).trim();
    const token = pair.slice(i + 1).trim();
    if (id && token) tokens.set(id, token);
  }
  return tokens;
}

function sameToken(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The market side of /ws/worker (PLAN 5.3) and the registry of connected workers. */
export class WorkerRegistry {
  private readonly workers = new Map<string, WorkerEntry>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
  private readonly silentMs: number;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly o: WorkerRegistryOptions) {
    this.silentMs = o.silentMs ?? WORKER_SILENT_MS;
    this.wss.on("connection", (socket) => this.accept(socket));
  }

  /** Called after anything a snapshot shows changes; returns the unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        this.o.log.error({ err }, "worker change listener failed");
      }
    }
  }

  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      if (path !== "/ws/worker") return;
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
    });
  }

  close(): void {
    for (const entry of this.workers.values()) entry.socket?.terminate();
    this.wss.close();
  }

  private accept(socket: WebSocket): void {
    let entry: WorkerEntry | null = null;
    const helloTimer = setTimeout(
      () => this.refuse(socket, "no_hello", "send hello first"),
      HELLO_TIMEOUT_MS,
    );

    socket.on("message", (data) => {
      let msg: WorkerToMarket;
      try {
        const raw: unknown = JSON.parse(data.toString());
        const parsed = WorkerToMarket.safeParse(raw);
        if (!parsed.success) {
          const issues = parsed.error.issues.slice(0, 3);
          this.o.log.warn({ workerId: entry?.workerId, issues }, "invalid worker message");
          // A hello outside the protocol (say, a string past its bound) is refused at once,
          // so the worker learns why instead of waiting for the hello timeout.
          if (!entry && (raw as { type?: unknown } | null)?.type === "hello") {
            clearTimeout(helloTimer);
            // The union's own error names no field; the hello schema's does.
            const helloIssues = HelloMsg.safeParse(raw).error?.issues ?? issues;
            const where = helloIssues
              .slice(0, 3)
              .map((i) => i.path.join(".") || i.message)
              .join(", ");
            this.refuse(socket, "invalid_hello", `hello does not fit the protocol: ${where}`);
          }
          return;
        }
        msg = parsed.data;
      } catch {
        this.o.log.warn({ workerId: entry?.workerId }, "unreadable worker message");
        return;
      }
      // ws does not catch listener errors: one bad message must not take the market down.
      try {
        if (!entry) {
          if (msg.type !== "hello") return this.refuse(socket, "no_hello", "send hello first");
          clearTimeout(helloTimer);
          entry = this.onHello(socket, msg);
          return;
        }
        this.touch(entry);
        this.onMessage(entry, msg);
      } catch (err) {
        this.o.log.error({ err, workerId: entry?.workerId }, "worker message handler failed");
      }
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (entry && entry.socket === socket) this.goOffline(entry, "connection closed");
    });
    socket.on("error", (err) => this.o.log.warn({ err: err.message }, "worker socket error"));
  }

  private refuse(socket: WebSocket, code: string, message: string): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: "error", code, message }));
      socket.close(1008, code);
    }
  }

  private onHello(socket: WebSocket, hello: HelloMsg): WorkerEntry | null {
    const expected = this.o.tokens.get(hello.workerId);
    if (!expected || !hello.token || !sameToken(hello.token, expected)) {
      this.o.log.warn({ workerId: hello.workerId }, "worker refused: bad token");
      this.refuse(socket, "unauthorized", "unknown worker or bad token");
      return null;
    }
    let prices: WorkerPrice[];
    try {
      prices = hello.prices.map((p) => ({ ...p, atomic: usdToAtomic(p.usd) }));
    } catch {
      this.o.log.warn({ workerId: hello.workerId }, "worker refused: price out of range");
      this.refuse(socket, "invalid_hello", "price out of range");
      return null;
    }
    const previous = this.workers.get(hello.workerId);
    if (previous?.socket && previous.socket !== socket) {
      const old = previous.socket;
      previous.socket = null;
      this.failPending(previous, "worker reconnected");
      old.terminate();
    }
    // Recalibrate on every reconnect (PLAN 6.5).
    const entry: WorkerEntry = {
      workerId: hello.workerId,
      name: hello.name,
      payTo: hello.payTo,
      hardware: hello.hardware,
      prices,
      ...(hello.schedule ? { schedule: hello.schedule } : {}),
      version: hello.version,
      socket,
      lastSeenAt: new Date(),
      warm: [...hello.warm],
      busy: false,
      calibration: {},
      calibrating: 0,
      untrusted: false,
      selling: true,
      calibrated: new Set(),
      pending: null,
    };
    this.workers.set(hello.workerId, entry);
    this.touch(entry);
    socket.send(
      JSON.stringify({
        type: "welcome",
        workerId: hello.workerId,
        serverTime: new Date().toISOString(),
      }),
    );
    this.o.log.info(
      { workerId: entry.workerId, name: entry.name, version: entry.version, warm: entry.warm },
      "worker online",
    );
    this.o.bus.emit({
      source: "market",
      type: "worker.online",
      data: { workerId: entry.workerId, name: entry.name },
    });
    for (const workload of entry.warm) this.requestCalibration(entry, workload);
    this.changed();
    return entry;
  }

  private touch(entry: WorkerEntry): void {
    entry.lastSeenAt = new Date();
    clearTimeout(entry.silence);
    entry.silence = setTimeout(() => {
      this.o.log.warn({ workerId: entry.workerId }, "worker silent: offline");
      const socket = entry.socket;
      this.goOffline(entry, `silent for ${this.silentMs / 1000} s`);
      socket?.terminate();
    }, this.silentMs);
  }

  private goOffline(entry: WorkerEntry, reason: string): void {
    if (!entry.socket) return;
    entry.socket = null;
    clearTimeout(entry.silence);
    entry.busy = false;
    entry.currentJobId = undefined;
    this.failPending(entry, "worker disconnected");
    this.changed();
    this.o.log.info({ workerId: entry.workerId, reason }, "worker offline");
    this.o.bus.emit({
      source: "market",
      type: "worker.offline",
      data: { workerId: entry.workerId, name: entry.name, reason },
    });
  }

  private requestCalibration(entry: WorkerEntry, workload: WorkloadName): void {
    if (entry.calibrated.has(workload)) return;
    entry.calibrated.add(workload);
    this.o.calibrate?.(this, entry.workerId, workload);
  }

  private onMessage(entry: WorkerEntry, msg: WorkerToMarket): void {
    switch (msg.type) {
      case "hello":
        return;
      case "heartbeat": {
        entry.util = msg.util;
        entry.busy = msg.busy;
        entry.currentJobId = msg.currentJobId;
        entry.warm = [...msg.warm];
        for (const workload of entry.warm) this.requestCalibration(entry, workload);
        this.changed();
        return;
      }
      case "job.accepted": {
        const job = entry.pending;
        if (job?.jobId !== msg.jobId || job.request.quiet) return;
        this.emitJob(job, "worker", "job.running", { workerId: entry.workerId });
        return;
      }
      case "job.progress": {
        const job = entry.pending;
        if (job?.jobId !== msg.jobId || job.request.quiet) return;
        this.emitJob(job, "worker", "job.progress", {
          workerId: entry.workerId,
          pct: msg.pct,
          ...(msg.note ? { note: msg.note } : {}),
        });
        return;
      }
      case "job.result": {
        const job = entry.pending;
        if (job?.jobId !== msg.jobId) return;
        const durationMs = Math.round(performance.now() - job.startedAt);
        const base = { jobId: job.jobId, workerId: entry.workerId, durationMs };
        if (!msg.ok) {
          this.settle(entry, { ...base, ok: false, error: msg.error }, "worker");
          return;
        }
        // Never trust the worker's own hash: recompute it from the bytes received.
        const data = Buffer.from(msg.dataBase64, "base64");
        const sha256 = createHash("sha256").update(data).digest("hex");
        if (sha256 !== msg.sha256 || data.length !== msg.bytes) {
          this.settle(entry, { ...base, ok: false, error: "result corrupted in transit" });
          return;
        }
        // Nor its word on the image: the market reads the PNG header itself. A mismatch
        // fails the job, so a paid one answers 502 and nothing is charged.
        let check: { kind: "png"; width: number; height: number } | undefined;
        if (job.request.workload === "image") {
          const want = job.request.params.size;
          const size = pngSize(data);
          if (!size || size.width !== want || size.height !== want) {
            const got = size ? `a ${size.width}×${size.height} PNG` : "something that is not a PNG";
            const error = `the market's check failed: asked for a ${want}×${want} PNG, got ${got}`;
            this.settle(entry, { ...base, ok: false, error });
            return;
          }
          check = { kind: "png", ...size };
        }
        this.settle(
          entry,
          {
            ...base,
            ok: true,
            mime: msg.mime,
            sha256,
            data,
            workerDurationMs: msg.durationMs,
            ...(check ? { check } : {}),
          },
          "worker",
        );
        return;
      }
    }
  }

  private emitJob(
    job: PendingJob,
    source: Decider,
    type: "job.dispatched" | "job.running" | "job.progress" | "job.completed" | "job.failed",
    data: Record<string, unknown>,
  ): void {
    this.o.bus.emit({
      source,
      type,
      jobId: job.jobId,
      ...(job.request.runId ? { runId: job.request.runId } : {}),
      ...(job.request.dev ? { dev: true } : {}),
      data,
    } as never);
  }

  /**
   * Ends the pending job. `decidedBy` is the event's source: the worker for what it reported
   * itself (its result, or its own failure); the market for what it decided (a missed
   * deadline, a disconnect, a result that failed its checks).
   */
  private settle(entry: WorkerEntry, outcome: JobOutcome, decidedBy: Decider = "market"): void {
    const job = entry.pending;
    if (!job || job.jobId !== outcome.jobId) return;
    entry.pending = null;
    clearTimeout(job.timer);
    this.changed();
    if (!job.request.quiet) {
      if (outcome.ok) {
        this.emitJob(job, decidedBy, "job.completed", {
          workerId: entry.workerId,
          durationMs: outcome.durationMs,
          sha256: outcome.sha256,
          mime: outcome.mime,
          bytes: outcome.data.length,
          ...(outcome.check ? { check: outcome.check } : {}),
        });
      } else {
        this.emitJob(job, decidedBy, "job.failed", {
          workerId: entry.workerId,
          reason: outcome.error,
        });
      }
    }
    job.resolve(outcome);
  }

  private failPending(entry: WorkerEntry, error: string): void {
    const job = entry.pending;
    if (!job) return;
    this.settle(entry, {
      ok: false,
      jobId: job.jobId,
      workerId: entry.workerId,
      error,
      durationMs: Math.round(performance.now() - job.startedAt),
    });
  }

  /** Runs one job on a worker and resolves with its result; never rejects. */
  dispatch(workerId: string, request: DispatchRequest): Promise<JobOutcome> {
    const jobId = request.jobId ?? nextJobId();
    const entry = this.workers.get(workerId);
    const refused = (error: string): Promise<JobOutcome> =>
      Promise.resolve({ ok: false, jobId, workerId, error, durationMs: 0 });
    if (!entry?.socket) return refused("worker offline");
    if (entry.pending) return refused("worker busy");
    const socket = entry.socket;

    return new Promise<JobOutcome>((resolve) => {
      const job: PendingJob = {
        jobId,
        request,
        startedAt: performance.now(),
        resolve,
        timer: setTimeout(
          () => {
            socket.send(JSON.stringify({ type: "job.cancel", jobId, reason: "deadline passed" }));
            this.failPending(
              entry,
              `no result within ${request.deadlineSec} s + ${RESULT_WAIT_GRACE_SEC} s`,
            );
          },
          (request.deadlineSec + RESULT_WAIT_GRACE_SEC) * 1000,
        ),
      };
      entry.pending = job;
      this.changed();
      if (!request.quiet) {
        this.emitJob(job, "market", "job.dispatched", {
          workerId,
          workload: request.workload,
          kind: request.kind,
          deadlineSec: request.deadlineSec,
          ...(request.offerId ? { offerId: request.offerId } : {}),
          ...(request.txHash ? { txHash: request.txHash } : {}),
          ...(request.estSec !== undefined ? { estSec: request.estSec } : {}),
        });
      }
      socket.send(
        JSON.stringify({
          type: "job.dispatch",
          jobId,
          kind: request.kind,
          workload: request.workload,
          params: request.params,
          deadlineSec: request.deadlineSec,
        }),
      );
    });
  }

  // Calibration state, driven by calibration.ts ------------------------------------------

  beginCalibration(workerId: string): void {
    const entry = this.workers.get(workerId);
    if (!entry) return;
    entry.calibrating += 1;
    this.changed();
  }

  endCalibration(workerId: string): void {
    const entry = this.workers.get(workerId);
    if (!entry) return;
    entry.calibrating = Math.max(0, entry.calibrating - 1);
    this.changed();
  }

  setCalibration(workerId: string, update: Partial<Calibration>, trusted = true): void {
    const entry = this.workers.get(workerId);
    if (!entry) return;
    entry.calibration = { ...entry.calibration, ...update };
    if (!trusted) entry.untrusted = true;
    this.changed();
  }

  isConnected(workerId: string): boolean {
    return this.workers.get(workerId)?.socket != null;
  }

  /** Connected, trusted, not calibrating and not running a job: it can take a paid job now. */
  isAvailable(workerId: string): boolean {
    const entry = this.workers.get(workerId);
    return entry !== undefined && this.statusOf(entry) === "online";
  }

  // Reads ------------------------------------------------------------------------------

  private statusOf(entry: WorkerEntry): WorkerStatus {
    if (!entry.socket) return "offline";
    if (entry.untrusted) return "untrusted";
    if (entry.calibrating > 0) return "calibrating";
    if (entry.pending || entry.busy) return "busy";
    return "online";
  }

  snapshots(): WorkerSnapshot[] {
    return [...this.workers.values()]
      .sort((a, b) => a.workerId.localeCompare(b.workerId))
      .map((entry) => ({
        workerId: entry.workerId,
        name: entry.name,
        payTo: entry.payTo,
        hardware: entry.hardware,
        prices: entry.prices,
        status: this.statusOf(entry),
        calibration: entry.calibration,
        warm: entry.warm,
        ...(entry.util ? { util: entry.util } : {}),
        ...(entry.schedule ? { schedule: entry.schedule } : {}),
        lastSeenAt: entry.lastSeenAt.toISOString(),
        ...((entry.pending?.jobId ?? entry.currentJobId)
          ? { currentJobId: entry.pending?.jobId ?? entry.currentJobId }
          : {}),
        selling: entry.selling,
        escrowSeller: this.o.escrowSeller !== undefined && entry.payTo === this.o.escrowSeller,
      }));
  }

  online(): number {
    let n = 0;
    for (const entry of this.workers.values()) if (entry.socket) n += 1;
    return n;
  }
}
