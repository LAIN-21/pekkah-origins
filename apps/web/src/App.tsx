import type { JobEvent, RunLog } from "@pekkah/protocol";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { DecisionPanel, RequestCard } from "./components/DecisionPanel";
import { Header, type ViewMode } from "./components/Header";
import { MarketPanel } from "./components/MarketPanel";
import { PaymentPanel, Timeline } from "./components/PaymentPanel";
import { ReceiptPanel, ResultPanel } from "./components/ResultPanel";
import { RunPanel } from "./components/RunPanel";
import { formatSeconds } from "./format";
import { useNow, useReplay } from "./hooks";
import { byId, deriveRun, latestBalance, runIds } from "./run";
import type { FeedSource } from "./source";
import { feedReducer, initialFeed } from "./store";

/** The replayed run's events join the live ones without duplicates. */
function withReplay(events: JobEvent[], replay: RunLog | null): JobEvent[] {
  if (!replay) return events;
  const seen = new Set(events.map((e) => e.id));
  const extra = replay.events.filter((e) => !seen.has(e.id));
  return extra.length ? [...events, ...extra].sort(byId) : events;
}

export function App({ source }: { source: FeedSource }) {
  const [state, dispatch] = useReducer(feedReducer, initialFeed);

  useEffect(
    () =>
      source.connect({
        onMessage: (message) => dispatch({ type: "message", message }),
        onConnection: (connection) => dispatch({ type: "connection", connection }),
      }),
    [source],
  );

  // Opened while idle: fetch the last real run once, for the replay.
  const askedReplay = useRef(false);
  useEffect(() => {
    if (askedReplay.current || !state.demo || state.demo.running) return;
    askedReplay.current = true;
    source
      .latestRun()
      .then((log) => {
        if (log) dispatch({ type: "replay", log });
      })
      .catch(() => {});
  }, [state.demo, source]);

  const events = useMemo(
    () => withReplay(state.events, state.replay),
    [state.events, state.replay],
  );
  const ids = useMemo(() => runIds(events), [events]);
  const runId = ids[ids.length - 1];
  const fullRun = useMemo(() => (runId ? deriveRun(runId, events) : null), [runId, events]);

  const live = Boolean(
    runId &&
      (state.liveRunIds.includes(runId) || (state.demo?.running && state.demo.runId === runId)),
  );
  const replaying = Boolean(fullRun) && !live;
  const replay = useReplay(fullRun?.events ?? [], replaying);
  const run =
    fullRun && replaying && !replay.done
      ? deriveRun(fullRun.runId, fullRun.events.slice(0, replay.shown))
      : fullRun;

  const mode: ViewMode = !fullRun
    ? { kind: "idle" }
    : live
      ? { kind: "live", running: fullRun.status === "running", at: fullRun.lastTs }
      : { kind: "replay", at: fullRun.started?.ts ?? fullRun.firstTs ?? new Date().toISOString() };

  const names = useMemo(
    () => new Map(state.workers.map((w) => [w.workerId, w.name])),
    [state.workers],
  );
  const name = useCallback((id: string) => names.get(id) ?? `Worker ${id}`, [names]);
  const online = state.workers.filter((w) => w.status !== "offline").length;

  return (
    <>
      <Header
        connection={state.connection}
        workersOnline={online}
        balance={latestBalance(events)}
        mode={mode}
        sourceLabel={source.label}
      />
      <main className="layout">
        <div className="col">
          <MarketPanel workers={state.workers} />
          <RunPanel demo={state.demo} connection={state.connection} onStart={source.startRun} />
        </div>
        <div className="col">
          <section className="panel" aria-labelledby="story-title">
            <div className="row between">
              <h2 id="story-title">{mode.kind === "replay" ? "The last real run" : "The run"}</h2>
              {mode.kind === "live" && mode.running && run?.started ? (
                <RunClock since={run.started.ts} />
              ) : null}
              {mode.kind === "replay" && replay.done ? (
                <button type="button" className="link" onClick={replay.restart}>
                  Replay again
                </button>
              ) : null}
            </div>
            {!run ? (
              <p className="muted">
                No run yet. Start one on the left, and every step appears here as it happens.
              </p>
            ) : (
              <div className="story">
                <RequestCard run={run} />
                <DecisionPanel run={run} name={name} />
                <PaymentPanel run={run} name={name} />
                <ResultPanel run={run} name={name} />
                <ReceiptPanel run={run} name={name} />
                <Timeline run={run} name={name} />
              </div>
            )}
          </section>
        </div>
      </main>
      <footer className="footer small muted">
        Cardano preprod only, paid in test tokens. Every step on this page is an event the market, a
        worker, my agent or the chain emitted.
      </footer>
    </>
  );
}

function RunClock({ since }: { since: string }) {
  const now = useNow(500);
  return (
    <span className="chip live">Running {formatSeconds((now - Date.parse(since)) / 1000)}</span>
  );
}
