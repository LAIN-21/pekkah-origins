import type { Server } from "node:http";
import type { DemoState, JobEvent, UiMessage, WorkerSnapshot } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import { type WebSocket, WebSocketServer } from "ws";
import type { EventBus } from "./events.js";

export interface UiHubOptions {
  bus: EventBus;
  workers: () => WorkerSnapshot[];
  /** Subscribes to worker changes; returns the unsubscribe function. */
  onWorkersChange: (listener: () => void) => () => void;
  demo: () => DemoState;
  log: Logger;
  recentEvents?: number;
}

/**
 * /ws/ui (PLAN 5.4): read-only. A snapshot first, then each event as it is emitted, the
 * workers at most once a second, and the demo state when it changes. The UI renders only
 * what arrives here, in this order.
 */
export class UiHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  private workersTimer: NodeJS.Timeout | undefined;
  private lastWorkersAt = 0;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly ping: NodeJS.Timeout;

  constructor(private readonly o: UiHubOptions) {
    this.wss.on("connection", (socket) => this.welcome(socket));
    this.unsubscribe.push(o.bus.subscribe((event) => this.broadcast({ type: "event", event })));
    this.unsubscribe.push(o.onWorkersChange(() => this.scheduleWorkers()));
    this.ping = setInterval(() => {
      for (const client of this.wss.clients) if (client.readyState === client.OPEN) client.ping();
    }, 30_000);
  }

  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      if (path !== "/ws/ui") return;
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
    });
  }

  close(): void {
    clearInterval(this.ping);
    clearTimeout(this.workersTimer);
    for (const off of this.unsubscribe) off();
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }

  /** Sent when the run button's state changes (PR-06b). */
  demoChanged(): void {
    this.broadcast({ type: "demo", demo: this.o.demo() });
  }

  private welcome(socket: WebSocket): void {
    // Read-only: anything a browser sends is ignored.
    socket.on("message", () => {});
    socket.on("error", () => {});
    const recentEvents: JobEvent[] = this.o.bus.latest(this.o.recentEvents ?? 200);
    this.send(socket, {
      type: "snapshot",
      workers: this.o.workers(),
      recentEvents,
      demo: this.o.demo(),
    });
  }

  private scheduleWorkers(): void {
    if (this.workersTimer) return;
    const wait = Math.max(0, this.lastWorkersAt + 1000 - Date.now());
    this.workersTimer = setTimeout(() => {
      this.workersTimer = undefined;
      this.lastWorkersAt = Date.now();
      this.broadcast({ type: "workers", workers: this.o.workers() });
    }, wait);
  }

  private broadcast(message: UiMessage): void {
    if (this.wss.clients.size === 0) return;
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  }

  private send(socket: WebSocket, message: UiMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }
}
