import {
  explorerAddressUrl,
  MASUMI_LOCK_LABEL,
  MASUMI_REFUNDED_LABEL,
  MASUMI_RELEASED_LABEL,
} from "@pekkah/protocol";
import { formatAsset, formatClock, formatLovelace, formatPosixMs, short } from "../format";
import { useNow } from "../hooks";
import type { Attempt, RunView } from "../run";

// The Masumi escrow, step by step, from the events the backend emitted (rule 4): "locked in
// escrow" until an escrow.released event exists for this lock, "released" only after it, and
// "refunded" only after an escrow.refunded event. Dispute isn't built: it is named as next.

const DEADLINES = [
  ["payByTime", "Pay by"],
  ["submitResultTime", "Result due"],
  ["unlockTime", "Unlock"],
  ["externalDisputeUnlockTime", "Dispute unlock"],
] as const;

/** "in 12:05" before the unlock, as a countdown from the backend's unlockTime. */
export function countdown(untilMs: number, now: number): string {
  const sec = Math.max(0, Math.round((untilMs - now) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h > 0 ? `in ${h}:${String(m).padStart(2, "0")}:${s}` : `in ${m}:${s}`;
}

function relative(ms: number, now: number): string {
  const min = Math.round((ms - now) / 60_000);
  if (min === 0) return "now";
  return min > 0 ? `in ${min} min` : `${-min} min ago`;
}

/** The attempt whose payment was locked in escrow (the last one, after a failover). */
export function escrowAttempt(run: RunView): Attempt | undefined {
  return [...run.attempts].reverse().find((a) => a.escrow);
}

type StepState = "done" | "active" | "pending";

function Step({
  state,
  title,
  children,
}: {
  state: StepState;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li className={state}>
      <span className="lc-title">{title}</span>
      {children ? <span className="lc-detail">{children}</span> : null}
    </li>
  );
}

function Tx({ href, hash }: { href: string; hash: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {short(hash, 10, 6)} ↗
    </a>
  );
}

export function EscrowPanel({ run, name }: { run: RunView; name: (workerId: string) => string }) {
  const a = escrowAttempt(run);
  const now = useNow(1000);
  if (!a?.escrow) return null;
  const d = a.escrow.data;
  const seller = a.workerId ? name(a.workerId) : "the seller";
  const unlock = Number(d.unlockTime);
  const unlocked = now >= unlock;
  const delivered = a.completed?.data.sha256;
  const submitted = a.resultSubmitted?.data;
  const released = a.released?.data;
  const refunded = a.refunded?.data;
  const label = released
    ? MASUMI_RELEASED_LABEL
    : refunded
      ? MASUMI_REFUNDED_LABEL
      : MASUMI_LOCK_LABEL;
  const status = released
    ? { text: `Released to ${seller}`, tone: "good" }
    : refunded
      ? { text: "Refunded to the buyer", tone: "warn" }
      : { text: "Locked in escrow", tone: "info" };

  return (
    <div className="card escrow-card">
      <div className="row between">
        <h3>Masumi escrow</h3>
        <span className={`chip ${status.tone}`}>{status.text}</span>
      </div>
      <ol className="lifecycle">
        <Step state="done" title="Locked in escrow">
          {formatAsset(d.amountAtomic)} plus {formatLovelace(d.collateralLovelace)} of collateral,
          with {seller} as the seller. <Tx href={d.explorerUrl} hash={d.txHash} />
        </Step>
        <Step
          state={submitted ? "done" : "active"}
          title={submitted ? "Result hash submitted" : "Result hash: not submitted yet"}
        >
          {submitted ? (
            <>
              {submitted.resultHash === delivered ? "It matches the delivered result. " : ""}
              <Tx href={submitted.explorerUrl} hash={submitted.txHash} />
            </>
          ) : (
            `Due by ${formatClock(new Date(Number(d.submitResultTime)).toISOString())}.`
          )}
        </Step>
        <Step
          state={unlocked ? "done" : submitted ? "active" : "pending"}
          title={`Unlocks at ${formatClock(new Date(unlock).toISOString())}`}
        >
          {unlocked ? (
            "Unlocked: the seller can collect."
          ) : (
            <span className="countdown">{countdown(unlock, now)}</span>
          )}
        </Step>
        {refunded ? (
          <Step state="done" title="Refunded to the buyer">
            {formatAsset(refunded.amountAtomic)} and{" "}
            {formatLovelace(refunded.collateralReturnLovelace)} of collateral went back to the
            buyer. <Tx href={refunded.explorerUrl} hash={refunded.txHash} />
          </Step>
        ) : released ? (
          <Step state="done" title={`Released to ${seller}`}>
            {formatAsset(released.amountAtomic)} to {seller}, and the buyer's{" "}
            {formatLovelace(released.collateralReturnLovelace)} of collateral came back.{" "}
            <Tx href={released.explorerUrl} hash={released.txHash} />
          </Step>
        ) : (
          <Step state={unlocked ? "active" : "pending"} title={`Release to ${seller}`}>
            After the unlock.
          </Step>
        )}
      </ol>
      <p className="escrow-label">{label}</p>
      {/dispute/i.test(label) ? null : (
        <p className="small muted">Dispute isn't built yet: it's my next step.</p>
      )}
      <details className="escrow-details">
        <summary>The terms</summary>
        <dl>
          <dt>Escrow</dt>
          <dd>
            <a href={explorerAddressUrl(d.escrowAddress)} target="_blank" rel="noreferrer">
              {short(d.escrowAddress, 12, 6)}
            </a>{" "}
            <span className="muted">Masumi vested_pay contract</span>
          </dd>
          <dt>Seller</dt>
          <dd>
            {seller},{" "}
            <a href={explorerAddressUrl(d.sellerAddress)} target="_blank" rel="noreferrer">
              {short(d.sellerAddress, 12, 6)}
            </a>
          </dd>
          <dt>Request hash</dt>
          <dd>
            <code title={d.inputHash}>{short(d.inputHash, 12, 8)}</code>{" "}
            <span className="muted">binds the lock to the exact request my agent quoted</span>
          </dd>
          {DEADLINES.map(([key, label]) => (
            <div className="deadline" key={key}>
              <dt>{label}</dt>
              <dd>
                {formatPosixMs(d[key])}{" "}
                <span className="muted">({relative(Number(d[key]), now)})</span>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
