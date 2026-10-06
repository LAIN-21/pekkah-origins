import type { JobEvent } from "@pekkah/protocol";
import { describeEvent, sourceLabel } from "../describe";
import { formatAsset, formatElapsed } from "../format";
import {
  type Attempt,
  isEscrow,
  PAYMENT_STEPS,
  type PaymentStep,
  type RunView,
  stepStates,
} from "../run";

const STEP_LABEL: Record<PaymentStep, string> = {
  required: "402",
  signed: "signed",
  verified: "verified",
  running: "running",
  delivered: "delivered",
  settling: "settling",
  settled: "settled",
};

interface Props {
  run: RunView;
  name: (workerId: string) => string;
}

export function PaymentPanel({ run, name }: Props) {
  if (run.attempts.length === 0) return null;
  return (
    <div className="card">
      <h3>
        {run.attempts.some(isEscrow)
          ? "How my agent locked the payment in escrow"
          : "How my agent paid"}
      </h3>
      {run.attempts.map((a, i) => (
        <AttemptView
          key={a.offerId ?? a.txHash ?? i}
          attempt={a}
          index={i}
          total={run.attempts.length}
          name={name}
        />
      ))}
    </div>
  );
}

function AttemptView({
  attempt: a,
  index,
  total,
  name,
}: {
  attempt: Attempt;
  index: number;
  total: number;
  name: (workerId: string) => string;
}) {
  const escrow = isEscrow(a);
  const states = stepStates(a);
  const amount = a.required?.data.amountAtomic ?? a.verified?.data.amountAtomic;
  const outcome = a.settled
    ? escrow
      ? { text: `Locked in escrow · seller: ${name(a.workerId ?? "")}`, tone: "good" }
      : { text: `Paid to ${name(a.workerId ?? "")}, the worker that ran the job`, tone: "good" }
    : a.canceled
      ? { text: "Cancelled: nothing was charged", tone: "bad" }
      : a.paymentFailed
        ? { text: `Payment failed: ${a.paymentFailed.data.reason}`, tone: "bad" }
        : null;
  return (
    <div className="attempt">
      <p className="small">
        {total > 1 ? <strong>Attempt {index + 1} · </strong> : null}
        {a.workerId ? name(a.workerId) : "—"}
        {amount ? ` · ${formatAsset(amount)}` : ""}
        {escrow ? " · through Masumi escrow" : ""}
      </p>
      <ol className="stepper">
        {PAYMENT_STEPS.map((step) => (
          <li key={step} className={states[step]}>
            {step === "settled" && escrow ? "locked in escrow" : STEP_LABEL[step]}
            {step === "running" && a.progress && !a.completed && !a.jobFailed
              ? ` ${Math.round(a.progress.data.pct)}%`
              : ""}
          </li>
        ))}
      </ol>
      {a.progress && !a.completed && !a.jobFailed ? (
        <div
          className="progress"
          role="progressbar"
          aria-label="Job progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(a.progress.data.pct)}
        >
          <span style={{ width: `${Math.max(0, Math.min(100, a.progress.data.pct))}%` }} />
        </div>
      ) : null}
      {outcome ? <p className={`outcome ${outcome.tone}`}>{outcome.text}</p> : null}
    </div>
  );
}

export function Timeline({ run, name }: Props) {
  if (run.events.length === 0) return null;
  const start = run.started?.ts ?? run.firstTs;
  return (
    <div className="card">
      <h3>Everything that happened, in order</h3>
      <ol className="timeline">
        {run.events
          .filter((e) => e.type !== "job.progress")
          .map((e) => (
            <TimelineItem key={e.id} event={e} start={start} name={name} />
          ))}
      </ol>
    </div>
  );
}

function TimelineItem({
  event,
  start,
  name,
}: {
  event: JobEvent;
  start?: string;
  name: (workerId: string) => string;
}) {
  const line = describeEvent(event, name);
  return (
    <li className={`tl ${line.tone}`}>
      <span className="tl-time">{start ? formatElapsed(start, event.ts) : ""}</span>
      <span className="tl-source">{sourceLabel(event)}</span>
      <span className="tl-body">
        <span className="tl-title">
          {line.href ? (
            <a href={line.href} target="_blank" rel="noreferrer">
              {line.title} ↗
            </a>
          ) : (
            line.title
          )}
        </span>
        {line.detail ? <span className="tl-detail">{line.detail}</span> : null}
      </span>
    </li>
  );
}
