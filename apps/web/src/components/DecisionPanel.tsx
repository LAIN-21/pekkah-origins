import { type EventOf, formatUsd, type Quote, type RejectionReason } from "@pekkah/protocol";
import { overBudgetText } from "../describe";
import { formatSeconds, requestLine, requestWhat } from "../format";
import type { RunView } from "../run";

const REASON_TEXT: Record<RejectionReason, string> = {
  offline: "offline",
  untrusted: "failed its answer check",
  not_calibrated: "not measured yet",
  busy: "busy with another job",
  outside_hours: "outside its live hours",
  no_workload: "doesn't sell this job",
  excluded: "excluded by my agent",
  no_gpu: "no GPU",
  vram_too_small: "not enough VRAM",
  too_slow: "too slow for the deadline",
  over_budget: "over budget",
};

/** The run's header, from what run.started says: the request and who started it. */
export function RequestCard({ run }: { run: RunView }) {
  const r = run.started?.data.request;
  if (!r) return null;
  return (
    <div className="card">
      <div className="row between">
        <h3>What my agent asked for</h3>
        {run.client ? <span className="chip info">{run.client}</span> : null}
      </div>
      <p className="request-what">{requestWhat(r)}</p>
      <p className="small muted">{requestLine(r)}</p>
    </div>
  );
}

interface DecisionProps {
  run: RunView;
  name: (workerId: string) => string;
}

export function DecisionPanel({ run, name }: DecisionProps) {
  if (run.quotes.length === 0) return null;
  return (
    <div className="card">
      <h3>Why my agent chose</h3>
      {run.quotes.map((q, i) => {
        const next = run.quotes[i + 1];
        return (
          <QuoteBlock
            key={q.id}
            quote={q.data.quote}
            decision={decisionFor(run.decisions, q, next)}
            name={name}
            heading={
              run.quotes.length > 1
                ? `Quote ${i + 1} · budget ${formatUsd(q.data.quote.request.budget.maxUsd)}`
                : undefined
            }
            waiting={!next && run.status === "running"}
          />
        );
      })}
    </div>
  );
}

/** The decision my agent emitted for this quote: after it, and before the next quote. */
export function decisionFor(
  decisions: EventOf<"agent.decision">[],
  quote: EventOf<"quote.issued">,
  next?: EventOf<"quote.issued">,
): EventOf<"agent.decision"> | undefined {
  return decisions.find((d) => d.id > quote.id && (!next || d.id < next.id));
}

interface Row {
  workerId: string;
  verdict: "offer" | "counter" | "rejected";
  text: string;
}

function rows(q: Quote): Row[] {
  const out: Row[] = [];
  for (const o of q.offers) {
    out.push({
      workerId: o.workerId,
      verdict: "offer",
      text: `${formatUsd(o.priceUsd)} · about ${formatSeconds(o.estSec)}`,
    });
  }
  const counter = q.counterOffer;
  if (counter) {
    out.push({
      workerId: counter.workerId,
      verdict: "counter",
      text: `${formatUsd(counter.priceUsd)} · about ${formatSeconds(counter.estSec)}`,
    });
  }
  for (const r of q.rejected) {
    // The counter-offer's worker is also listed as over budget; show it once.
    if (counter && r.workerId === counter.workerId) continue;
    out.push({
      workerId: r.workerId,
      verdict: "rejected",
      // The market's detail often just repeats the reason ("No GPU"): say it once.
      text:
        r.detail.toLowerCase() === REASON_TEXT[r.reason].toLowerCase()
          ? r.detail
          : `${REASON_TEXT[r.reason]}: ${r.detail}`,
    });
  }
  return out.sort((a, b) => a.workerId.localeCompare(b.workerId));
}

function QuoteBlock({
  quote,
  decision,
  name,
  heading,
  waiting,
}: {
  quote: Quote;
  decision?: EventOf<"agent.decision">;
  name: (workerId: string) => string;
  heading?: string;
  /** The newest quote of an unfinished run: no decision on it yet. */
  waiting: boolean;
}) {
  const chosen = decision?.data.chosen?.workerId;
  return (
    <div className="quote">
      {heading ? <h4>{heading}</h4> : null}
      <table className="offers">
        <tbody>
          {rows(quote).map((r) => (
            <tr key={`${r.workerId}-${r.verdict}`} className={r.verdict}>
              <td className="mark" aria-hidden="true">
                {r.verdict === "offer" ? "✓" : r.verdict === "counter" ? "↺" : "✗"}
              </td>
              <td className="who">
                {name(r.workerId)}
                {chosen === r.workerId ? <span className="chip info tiny">chosen</span> : null}
              </td>
              <td>
                {r.verdict === "counter" ? "counter-offer: " : ""}
                {r.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small">
        {quote.counterOffer ? (
          // The market's own reason already names the market price.
          quote.counterOffer.reason
        ) : (
          <>
            Market price:{" "}
            <strong>
              {quote.marketPriceUsd === null ? "none" : formatUsd(quote.marketPriceUsd)}
            </strong>
          </>
        )}
      </p>
      {decision ? (
        <div className={`decision ${decision.data.kind}`}>
          <p>
            <strong>
              {decision.data.kind === "declined"
                ? "My agent declined."
                : decision.data.kind === "counter"
                  ? "My agent accepted the counter-offer."
                  : "My agent took the best exact offer."}
            </strong>
          </p>
          <ul className="small">
            {decision.data.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {decision.data.overBudget ? (
            <p className="statement small">{overBudgetText(decision.data.overBudget)}</p>
          ) : null}
        </div>
      ) : (
        <p className="small muted">
          {waiting
            ? "My agent hasn't decided yet."
            : "My agent didn't take an offer from this quote."}
        </p>
      )}
    </div>
  );
}
