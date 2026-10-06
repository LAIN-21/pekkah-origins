import { ASSET_SYMBOL, explorerAddressUrl } from "@pekkah/protocol";
import { useState } from "react";
import { formatAsset, formatClockSeconds, formatLovelace, formatMs, short } from "../format";
import { type Attempt, isEscrow, type RunView } from "../run";

/** The attempt that delivered and has a receipt (the last one in a failover). */
function paidAttempt(run: RunView): Attempt | undefined {
  return [...run.attempts].reverse().find((a) => a.receipt);
}

export function ResultPanel({ run, name }: { run: RunView; name: (workerId: string) => string }) {
  const a = paidAttempt(run);
  // The market keeps results in memory, so a replay after a restart can't load them.
  const [lost, setLost] = useState<string | null>(null);
  const delivered = [...run.attempts].reverse().find((x) => x.completed);
  if (!a?.receipt) {
    if (delivered && !delivered.settled && !delivered.canceled && !delivered.paymentFailed) {
      return (
        <div className="card">
          <h3>Result</h3>
          <p className="muted">Delivered. It unlocks once the payment is on chain.</p>
        </div>
      );
    }
    return null;
  }
  const completed = a.completed?.data;
  const url = a.receipt.data.resultUrl;
  return (
    <div className="card">
      <h3>Result</h3>
      {!url ? (
        <p className="muted">The market didn't attach the result to this receipt.</p>
      ) : lost === url ? (
        <p className="muted">The market no longer has this result (it keeps results in memory).</p>
      ) : (
        <img
          className="result"
          src={url}
          alt="The delivered result of the job"
          onError={() => setLost(url)}
        />
      )}
      {completed ? (
        <p className="small muted">
          Made by {name(completed.workerId)} in {formatMs(completed.durationMs)} · sha256{" "}
          {short(completed.sha256, 10, 6)}
          {completed.check
            ? ` · checked by the market: a PNG, ${completed.check.width}×${completed.check.height} ✓`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

export function ReceiptPanel({ run, name }: { run: RunView; name: (workerId: string) => string }) {
  const a = paidAttempt(run);
  const r = a?.receipt?.data.receipt;
  if (!a || !r) return null;
  const escrow = isEscrow(a);
  const worker = a.workerId ? name(a.workerId) : "—";
  return (
    <div className="card receipt">
      <h3>Receipt</h3>
      <dl>
        <dt>Transaction</dt>
        <dd>
          <a href={r.explorerUrl} target="_blank" rel="noreferrer">
            {short(r.txHash, 12, 8)} ↗
          </a>
        </dd>
        <dt>Amount</dt>
        <dd>{formatAsset(r.amountAtomic)}</dd>
        <dt>{escrow ? "Status" : "Paid to"}</dt>
        <dd>
          {escrow ? (
            a.released ? (
              `Released to ${worker} after the unlock`
            ) : a.refunded ? (
              "Refunded to the buyer"
            ) : (
              `Locked in escrow · seller: ${worker}`
            )
          ) : (
            <>
              {worker},{" "}
              <a href={explorerAddressUrl(r.payTo)} target="_blank" rel="noreferrer">
                {short(r.payTo, 12, 6)}
              </a>
            </>
          )}
        </dd>
        <dt>Network</dt>
        <dd>Cardano preprod (test {ASSET_SYMBOL})</dd>
        {r.confirmations !== undefined ? (
          <>
            <dt>Confirmations</dt>
            <dd>{r.confirmations === 0 ? "in a block" : r.confirmations}</dd>
          </>
        ) : null}
        {r.feeLovelace ? (
          <>
            <dt>Network fee</dt>
            <dd>{formatLovelace(r.feeLovelace)}</dd>
          </>
        ) : null}
        {r.lovelaceInPaymentOutput && !escrow ? (
          <>
            <dt>Minimum ADA</dt>
            <dd>
              {formatLovelace(r.lovelaceInPaymentOutput)} travels with every token payment on
              Cardano.
            </dd>
          </>
        ) : null}
        <dt>{escrow ? "Locked at" : "Settled at"}</dt>
        <dd>{formatClockSeconds(r.settledAt)}</dd>
      </dl>
    </div>
  );
}
