import { type EventOf, explorerAddressUrl, MASUMI_LOCK_LABEL } from "@pekkah/protocol";
import { formatAsset, formatLovelace, formatPosixMs, short } from "../format";
import { useNow } from "../hooks";

// The Masumi lock (PR-10) as the escrow.locked event reports it. Wording rule
// (PLAN 4.8): the funds are "locked in escrow". Nothing here says the worker was
// paid or that anything was released: I lock, I don't release, refund or dispute.

const DEADLINES = [
  ["payByTime", "Pay by"],
  ["submitResultTime", "Result due"],
  ["unlockTime", "Unlock"],
  ["externalDisputeUnlockTime", "Dispute unlock"],
] as const;

function relative(ms: number, now: number): string {
  const min = Math.round((ms - now) / 60_000);
  if (min === 0) return "now";
  return min > 0 ? `in ${min} min` : `${-min} min ago`;
}

export function EscrowCard({ lock, seller }: { lock: EventOf<"escrow.locked">; seller: string }) {
  const d = lock.data;
  const now = useNow(30_000);
  return (
    <div className="escrow">
      <h4>Masumi escrow</h4>
      <p className="escrow-label">{MASUMI_LOCK_LABEL}</p>
      <dl>
        <dt>Locked</dt>
        <dd>
          {formatAsset(d.amountAtomic)} plus {formatLovelace(d.collateralLovelace)} collateral
        </dd>
        <dt>Seller</dt>
        <dd>
          {seller},{" "}
          <a href={explorerAddressUrl(d.sellerAddress)} target="_blank" rel="noreferrer">
            {short(d.sellerAddress, 12, 6)}
          </a>
        </dd>
        <dt>Escrow</dt>
        <dd>
          <a href={explorerAddressUrl(d.escrowAddress)} target="_blank" rel="noreferrer">
            {short(d.escrowAddress, 12, 6)}
          </a>{" "}
          <span className="muted">Masumi vested_pay contract</span>
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
        <dt>Lock transaction</dt>
        <dd>
          <a href={d.explorerUrl} target="_blank" rel="noreferrer">
            {short(d.txHash, 12, 8)} ↗
          </a>{" "}
          <span className="muted">the inline datum is on Cardanoscan</span>
        </dd>
      </dl>
    </div>
  );
}
