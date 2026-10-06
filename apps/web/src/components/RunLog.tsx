import type { JobEvent } from "@pekkah/protocol";
import { useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { checkLine, describeEvent, type EventLine, sourceLabel } from "../describe";
import { atBottom, LOG_FOLLOWING, logFollow } from "../follow";
import { formatElapsed } from "../format";
import type { RunView } from "../run";

interface Row {
  key: string;
  event: JobEvent;
  source: string;
  line: EventLine;
}

/** The log's rows: every event but progress ticks, with the market's PNG check as its own row. */
export function logRows(
  events: readonly JobEvent[],
  name: (workerId: string) => string,
  seller?: (address: string) => string | undefined,
): Row[] {
  const rows: Row[] = [];
  for (const e of events) {
    if (e.type === "job.progress") continue;
    rows.push({
      key: e.id,
      event: e,
      source: sourceLabel(e),
      line: describeEvent(e, name, seller),
    });
    if (e.type === "job.completed") {
      const check = checkLine(e);
      if (check) rows.push({ key: `${e.id}:check`, event: e, source: "Market", line: check });
    }
  }
  return rows;
}

interface Props {
  run: RunView;
  name: (workerId: string) => string;
  seller?: (address: string) => string | undefined;
}

/**
 * Everything that happened, in order, in its own scroll box. It follows the newest row while the
 * viewer is at the bottom; scrolling up pauses it, and "Jump to latest" resumes. Mount it with
 * key={runId}, so each run starts following.
 */
export function RunLog({ run, name, seller }: Props) {
  const rows = useMemo(() => logRows(run.events, name, seller), [run.events, name, seller]);
  const box = useRef<HTMLDivElement>(null);
  const [follow, dispatch] = useReducer(logFollow, LOG_FOLLOWING);
  const shown = useRef(rows.length);
  const start = run.started?.ts ?? run.firstTs;

  // Before paint: the new rows are in, so the box can follow them without a flicker.
  useLayoutEffect(() => {
    const added = rows.length - shown.current;
    shown.current = rows.length;
    if (added > 0) dispatch({ type: "rows", added });
    const el = box.current;
    if (el && follow.following) el.scrollTop = el.scrollHeight;
  }, [rows.length, follow.following]);

  const jump = () => {
    dispatch({ type: "jump" });
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  if (rows.length === 0) return null;
  return (
    <div className="card log-card">
      <h3>Everything that happened, in order</h3>
      <div
        className="log-box"
        ref={box}
        role="log"
        aria-label="Every event of this run, newest last"
        onScroll={(e) => dispatch({ type: "scrolled", atBottom: atBottom(e.currentTarget) })}
      >
        <ol className="timeline">
          {rows.map((r) => (
            <li key={r.key} className={`tl ${r.line.tone}`}>
              <span className="tl-time">{start ? formatElapsed(start, r.event.ts) : ""}</span>
              <span className="tl-source">{r.source}</span>
              <span className="tl-body">
                <span className="tl-title">
                  {r.line.href ? (
                    <a href={r.line.href} target="_blank" rel="noreferrer">
                      {r.line.title} ↗
                    </a>
                  ) : (
                    r.line.title
                  )}
                </span>
                {r.line.detail ? <span className="tl-detail">{r.line.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </div>
      {follow.following ? null : (
        <button type="button" className="log-jump" onClick={jump}>
          Jump to latest
          {follow.unseen > 0 ? ` (${follow.unseen} new)` : ""}
        </button>
      )}
    </div>
  );
}
