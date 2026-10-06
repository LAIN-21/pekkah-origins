import type { DemoState, JobEvent, RunLog, UiMessage, WorkerSnapshot } from "@pekkah/protocol";
import { byId } from "./run";

export type Connection = "connecting" | "open" | "closed";

export interface FeedState {
  connection: Connection;
  workers: WorkerSnapshot[];
  demo: DemoState | null;
  /** Every event seen, deduplicated by id, in emission order. */
  events: JobEvent[];
  /** Runs that received at least one event live, while this page was open. */
  liveRunIds: string[];
  /** The last real run, fetched for the replay when the page opened idle. */
  replay: RunLog | null;
}

export type FeedAction =
  | { type: "connection"; connection: Connection }
  | { type: "message"; message: UiMessage }
  | { type: "replay"; log: RunLog };

export const initialFeed: FeedState = {
  connection: "connecting",
  workers: [],
  demo: null,
  events: [],
  liveRunIds: [],
  replay: null,
};

/** Enough for many runs; older events drop off. */
const MAX_EVENTS = 3000;

function mergeEvents(current: JobEvent[], incoming: readonly JobEvent[]): JobEvent[] {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id));
  if (fresh.length === 0) return current;
  const merged = [...current, ...fresh].sort(byId);
  return merged.length > MAX_EVENTS ? merged.slice(merged.length - MAX_EVENTS) : merged;
}

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.connection };
    case "replay":
      return { ...state, replay: action.log };
    case "message": {
      const m = action.message;
      switch (m.type) {
        case "snapshot":
          return {
            ...state,
            workers: m.workers,
            demo: m.demo,
            events: mergeEvents(state.events, m.recentEvents),
          };
        case "workers":
          return { ...state, workers: m.workers };
        case "demo":
          return { ...state, demo: m.demo };
        case "event": {
          const runId = m.event.runId;
          const live =
            runId && !m.event.dev && !state.liveRunIds.includes(runId)
              ? [...state.liveRunIds, runId]
              : state.liveRunIds;
          return { ...state, events: mergeEvents(state.events, [m.event]), liveRunIds: live };
        }
        default:
          return state;
      }
    }
    default:
      return state;
  }
}
