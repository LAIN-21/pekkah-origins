import { RECONNECT_INITIAL_MS, RECONNECT_MAX_MS, UiMessage } from "@pekkah/protocol";
import type { Connection } from "./store";

export interface FeedHandlers {
  onMessage: (message: UiMessage) => void;
  onConnection: (connection: Connection) => void;
}

/**
 * The market's read-only /ws/ui. Reconnects with backoff (1 s, doubling, at most
 * 5 s); the market sends a fresh snapshot on every connect. Messages that don't
 * match the protocol are dropped, never guessed at.
 */
export function connectFeed({ onMessage, onConnection }: FeedHandlers): () => void {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/ui`;
  let socket: WebSocket | null = null;
  let delay = RECONNECT_INITIAL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = () => {
    onConnection("connecting");
    socket = new WebSocket(url);
    socket.onopen = () => {
      delay = RECONNECT_INITIAL_MS;
      onConnection("open");
    };
    socket.onmessage = (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        console.warn("ui feed: dropped a message that is not JSON");
        return;
      }
      const parsed = UiMessage.safeParse(raw);
      if (parsed.success) onMessage(parsed.data);
      else console.warn("ui feed: dropped a message that doesn't match the protocol", parsed.error);
    };
    socket.onclose = () => {
      onConnection("closed");
      if (stopped) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    };
    socket.onerror = () => socket?.close();
  };

  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}
