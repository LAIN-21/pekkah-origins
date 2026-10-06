import { afterEach, describe, expect, it, vi } from "vitest";
import { connectFeed } from "./feed";
import type { Connection } from "./store";

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
  }
}

function setup() {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", { protocol: "https:", host: "market.test" });
  const states: Connection[] = [];
  const messages: unknown[] = [];
  return {
    states,
    messages,
    handlers: {
      onConnection: (c: Connection) => states.push(c),
      onMessage: (m: unknown) => messages.push(m),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("connectFeed", () => {
  it("connects to wss://<host>/ws/ui and drops messages that don't match the protocol", () => {
    const { handlers, states, messages } = setup();
    connectFeed(handlers);
    const ws = FakeSocket.all[0];
    expect(ws?.url).toBe("wss://market.test/ws/ui");
    ws?.onopen?.();
    ws?.onmessage?.({ data: "not json" });
    ws?.onmessage?.({ data: JSON.stringify({ type: "nonsense" }) });
    ws?.onmessage?.({
      data: JSON.stringify({
        type: "demo",
        demo: { running: false, cooldownUntil: null, runsLeftToday: 40 },
      }),
    });
    expect(states).toEqual(["connecting", "open"]);
    expect(messages).toHaveLength(1);
  });

  it("ignores a stale socket's late close after cleanup (StrictMode runs effects twice)", () => {
    const { handlers, states } = setup();
    const stop = connectFeed(handlers);
    const first = FakeSocket.all[0];
    stop();
    expect(first?.closed).toBe(true);
    expect(first?.onclose).toBeNull();

    connectFeed(handlers);
    const second = FakeSocket.all[1];
    second?.onopen?.();
    // The first socket's close event arrives late; nothing listens to it any more.
    first?.onclose?.();
    expect(states.at(-1)).toBe("open");
  });

  it("reconnects with backoff after a close", () => {
    vi.useFakeTimers();
    const { handlers, states } = setup();
    connectFeed(handlers);
    FakeSocket.all[0]?.onclose?.();
    expect(states).toEqual(["connecting", "closed"]);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]?.onclose?.();
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
  });
});
