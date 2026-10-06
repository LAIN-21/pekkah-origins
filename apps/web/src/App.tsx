import type { JobEvent, RunLog as RunLogData } from "@pekkah/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { DecisionPanel, RequestCard } from "./components/DecisionPanel";
import { EscrowPanel } from "./components/EscrowCard";
import { Header, type ViewMode } from "./components/Header";
import { MarketPanel, MarketStrip } from "./components/MarketPanel";
import { PaymentPanel } from "./components/PaymentPanel";
import { ReceiptPanel, ResultPanel } from "./components/ResultPanel";
import { RunLog } from "./components/RunLog";
import { RunPanel } from "./components/RunPanel";
import { isScrollKey, pageFollow, scrollTargetY, unionBox } from "./follow";
import { formatSeconds, short } from "./format";
import { useNow, useReplay } from "./hooks";
import {
  byId,
  currentStep,
  deriveRun,
  isRecentUnfinished,
  LIVE_WINDOW_MS,
  latestBalance,
  runIds,
  type StoryStep,
} from "./run";
import type { FeedSource } from "./source";
import { feedReducer, initialFeed } from "./store";

/** Fetched runs (the replay, a pinned run) join the live events without duplicates. */
function withLogs(events: JobEvent[], logs: readonly (RunLogData | null)[]): JobEvent[] {
  const seen = new Set(events.map((e) => e.id));
  const extra: JobEvent[] = [];
  for (const log of logs) {
    for (const e of log?.events ?? []) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      extra.push(e);
    }
  }
  return extra.length ? [...events, ...extra].sort(byId) : events;
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** This page without ?run=, for "Show the latest run". */
function latestHref(): string {
  const params = new URLSearchParams(location.search);
  params.delete("run");
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}`;
}

/** One part of the story. The page follows it by its data-step. */
function Step({
  name,
  current,
  children,
}: {
  name: StoryStep;
  current: boolean;
  children: ReactNode;
}) {
  return (
    <div className={current ? "step current" : "step"} data-step={name}>
      {children}
    </div>
  );
}

interface Props {
  source: FeedSource;
  /** ?run=<runId>: that run, live or finished, stays on screen whatever starts after it. */
  pinnedRunId?: string;
}

export function App({ source, pinnedRunId }: Props) {
  const [state, dispatch] = useReducer(feedReducer, initialFeed);

  useEffect(
    () =>
      source.connect({
        onMessage: (message) => dispatch({ type: "message", message }),
        onConnection: (connection) => dispatch({ type: "connection", connection }),
      }),
    [source],
  );

  useEffect(() => {
    if (!pinnedRunId) return;
    let cancelled = false;
    const done = (log: RunLogData | null) => {
      if (!cancelled) dispatch({ type: "pinned", log: log ?? "missing" });
    };
    source.fetchRun(pinnedRunId).then(done, () => done(null));
    return () => {
      cancelled = true;
    };
  }, [source, pinnedRunId]);

  // Opened while idle: fetch the last real run once, for the replay.
  const askedReplay = useRef(false);
  useEffect(() => {
    if (pinnedRunId || askedReplay.current || !state.demo || state.demo.running) return;
    askedReplay.current = true;
    source
      .latestRun()
      .then((log) => {
        if (log) dispatch({ type: "replay", log });
      })
      .catch(() => {});
  }, [state.demo, source, pinnedRunId]);

  const pinnedLog = state.pinned !== null && state.pinned !== "missing" ? state.pinned : null;
  const events = useMemo(
    () => withLogs(state.events, [state.replay, pinnedLog]),
    [state.events, state.replay, pinnedLog],
  );
  const ids = useMemo(() => runIds(events), [events]);
  const runId = pinnedRunId ?? ids[ids.length - 1];
  const fullRun = useMemo(() => {
    const run = runId ? deriveRun(runId, events) : null;
    return run && run.events.length > 0 ? run : null;
  }, [runId, events]);

  // Live: it got an event while this page was open, the run button is running it, or the page
  // opened mid-run (unfinished, with an event in the last 15 minutes).
  const now = useNow(30_000);
  const live = Boolean(
    fullRun &&
      (state.liveRunIds.includes(fullRun.runId) ||
        (state.demo?.running && state.demo.runId === fullRun.runId) ||
        isRecentUnfinished(fullRun, now, LIVE_WINDOW_MS)),
  );
  const pinned = Boolean(pinnedRunId);
  const replaying = Boolean(fullRun) && !live && !pinned;
  const replay = useReplay(fullRun?.events ?? [], replaying);
  const run =
    fullRun && replaying && !replay.done
      ? deriveRun(fullRun.runId, fullRun.events.slice(0, replay.shown))
      : fullRun;

  const startedAt = (r: NonNullable<typeof run>) =>
    r.started?.ts ?? r.firstTs ?? new Date().toISOString();
  const mode: ViewMode = !run
    ? { kind: "idle" }
    : live
      ? { kind: "live", running: run.status === "running", at: run.lastTs }
      : pinned
        ? { kind: "pinned", at: startedAt(run) }
        : { kind: "replay", at: startedAt(run) };
  // A live or pinned run is the page's subject: the story goes first and widest.
  const storyFirst = mode.kind === "live" || mode.kind === "pinned";

  // Follow live: the current step is highlighted and kept in view, until the viewer scrolls.
  const [follow, followDispatch] = useReducer(pageFollow, { on: true });
  useEffect(() => followDispatch({ type: "run", runId: run?.runId }), [run?.runId]);
  useEffect(() => {
    const viewer = () => followDispatch({ type: "viewerScrolled" });
    // Scrolling the log box, or typing in a field, isn't scrolling the page.
    const inside = (target: EventTarget | null) =>
      target instanceof Element && target.closest(".log-box, input, select, textarea") !== null;
    const onWheel = (e: WheelEvent) => {
      if (!inside(e.target)) viewer();
    };
    const onTouch = (e: TouchEvent) => {
      if (!inside(e.target)) viewer();
    };
    const onKey = (e: KeyboardEvent) => {
      if (isScrollKey(e.key) && !inside(e.target)) viewer();
    };
    // A press on the page's own scrollbar lands on the root element.
    const onPointer = (e: PointerEvent) => {
      if (e.target === document.documentElement) viewer();
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchmove", onTouch, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchmove", onTouch);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, []);

  const step = run ? currentStep(run) : undefined;
  const following = follow.on && storyFirst;
  const eventCount = run?.events.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new event can grow the current step
  useEffect(() => {
    if (!following || !step) return;
    const boxes = [...document.querySelectorAll<HTMLElement>(`[data-step="${step}"]`)]
      .filter((el) => el.offsetHeight > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top + window.scrollY, height: r.height };
      });
    const box = unionBox(boxes);
    if (!box) return;
    const y = scrollTargetY(box, { scrollY: window.scrollY, height: window.innerHeight });
    if (y !== null) window.scrollTo({ top: y, behavior: reducedMotion() ? "auto" : "smooth" });
  }, [following, step, eventCount]);

  const names = useMemo(
    () => new Map(state.workers.map((w) => [w.workerId, w.name])),
    [state.workers],
  );
  const name = useCallback((id: string) => names.get(id) ?? `Worker ${id}`, [names]);
  const sellers = useMemo(
    () => new Map(state.workers.map((w) => [w.payTo, w.name])),
    [state.workers],
  );
  const seller = useCallback((address: string) => sellers.get(address), [sellers]);
  const online = state.workers.filter((w) => w.status !== "offline").length;
  const current = (s: StoryStep) => following && step === s;

  const head = (
    <div className="row between story-head">
      <h2 id="story-title">
        {mode.kind === "replay"
          ? "The last real run"
          : mode.kind === "pinned"
            ? "A real run"
            : "The run"}
      </h2>
      <div className="row">
        {mode.kind === "live" && mode.running && run?.started ? (
          <RunClock since={run.started.ts} />
        ) : null}
        {storyFirst ? (
          <button
            type="button"
            className={follow.on ? "chip follow on" : "chip follow"}
            aria-pressed={follow.on}
            onClick={() => followDispatch({ type: "toggle" })}
          >
            {follow.on ? "Following live" : "Follow live"}
          </button>
        ) : null}
        {mode.kind === "replay" && replay.done ? (
          <button type="button" className="link" onClick={replay.restart}>
            Replay again
          </button>
        ) : null}
        {pinned ? (
          <a className="small" href={latestHref()}>
            Show the latest run
          </a>
        ) : null}
      </div>
    </div>
  );

  const body = !run ? (
    pinnedRunId ? (
      <p className="muted">
        {state.pinned === "missing"
          ? `The market doesn't have run ${short(pinnedRunId)}: it keeps the last 30 runs.`
          : `Loading run ${short(pinnedRunId)}…`}
      </p>
    ) : (
      <p className="muted">
        No run yet. Start one on this page, and every step appears here as it happens.
      </p>
    )
  ) : (
    <div className="story">
      <Step name="request" current={current("request")}>
        <RequestCard run={run} />
      </Step>
      <Step name="decision" current={current("decision")}>
        <DecisionPanel run={run} name={name} />
      </Step>
      <Step name="payment" current={current("payment")}>
        <PaymentPanel run={run} name={name} />
      </Step>
      <Step name="result" current={current("result")}>
        <ResultPanel run={run} name={name} />
        <ReceiptPanel run={run} name={name} />
      </Step>
      <Step name="escrow" current={current("escrow")}>
        <EscrowPanel run={run} name={name} />
      </Step>
    </div>
  );

  const log = run ? <RunLog key={run.runId} run={run} name={name} seller={seller} /> : null;
  const story = (
    <section className="panel" aria-labelledby="story-title">
      {head}
      {body}
      {storyFirst ? null : log}
    </section>
  );
  const runPanel = (
    <RunPanel
      demo={state.demo}
      connection={state.connection}
      events={events}
      onStart={source.startRun}
    />
  );

  return (
    <>
      <Header
        connection={state.connection}
        workersOnline={online}
        balance={latestBalance(events, run?.runId)}
        mode={mode}
        sourceLabel={source.label}
      />
      {storyFirst ? (
        <main className="layout story-first">
          <div className="col">
            {story}
            {runPanel}
          </div>
          <aside className="col side" aria-label="The market and every event">
            <MarketStrip workers={state.workers} />
            {log}
          </aside>
        </main>
      ) : (
        <main className="layout">
          <div className="col">
            <MarketPanel workers={state.workers} />
            {runPanel}
          </div>
          <div className="col">{story}</div>
        </main>
      )}
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
