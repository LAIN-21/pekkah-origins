import {
  type ComputeRequest,
  type EventOf,
  formatUsd,
  type Quote,
  type RejectionReason,
  SCENARIOS,
} from "@pekkah/protocol";
import { formatSeconds } from "../format";
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

export function RequestCard({ run }: { run: RunView }) {
  const r = run.started?.data.request;
  if (!r) return null;
  return (
    <div className="card">
      <h3>What my agent asked for</h3>
      {run.scenario && <p>{SCENARIOS[run.scenario].summary}</p>}
      <p className="small muted">{requestLine(r)}</p>
    </div>
  );
}

function requestLine(r: ComputeRequest): string {
  const parts: string[] = [];
  if (r.workload === "image") {
    parts.push(`Image ${r.params.size}², ${r.params.steps} steps: “${r.params.prompt}”`);
  } else {
    parts.push(`CPU render, preset ${r.params.preset}`);
  }
  if (r.constraints.gpu)
    parts.push(`GPU${r.constraints.minVramGb ? ` ≥ ${r.constraints.minVramGb} GB` : ""}`);
  parts.push(`deadline ${r.constraints.deadlineSec} s`);
  parts.push(`at most ${formatUsd(r.budget.maxUsd)}`);
  if (r.constraints.exclude?.length) parts.push(`not ${r.constraints.exclude.join(", ")}`);
  return parts.join(" · ");
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
      {run.quotes.map((q, i) => (
        <QuoteBlock
          key={q.id}
          quote={q.data.quote}
          decision={decisionAfter(run.decisions, q)}
          name={name}
          heading={
            run.quotes.length > 1 ? (i === 0 ? "First quote" : "After rerouting") : undefined
          }
        />
      ))}
    </div>
  );
}

/** The decision my agent emitted for this quote: the first one after it. */
function decisionAfter(
  decisions: EventOf<"agent.decision">[],
  quote: EventOf<"quote.issued">,
): EventOf<"agent.decision"> | undefined {
  return decisions.find((d) => d.id > quote.id);
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
      text: `${REASON_TEXT[r.reason]}: ${r.detail}`,
    });
  }
  return out.sort((a, b) => a.workerId.localeCompare(b.workerId));
}

function QuoteBlock({
  quote,
  decision,
  name,
  heading,
}: {
  quote: Quote;
  decision?: EventOf<"agent.decision">;
  name: (workerId: string) => string;
  heading?: string;
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
        </div>
      ) : null}
    </div>
  );
}
