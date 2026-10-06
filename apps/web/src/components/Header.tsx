import type { EventOf } from "@pekkah/protocol";
import { formatAdaRounded, formatAsset, formatClock } from "../format";
import type { Connection } from "../store";

export type ViewMode =
  | { kind: "live"; running: boolean; at?: string }
  | { kind: "replay"; at: string }
  | { kind: "idle" };

interface Props {
  connection: Connection;
  workersOnline: number;
  balance?: EventOf<"agent.balance">;
  mode: ViewMode;
  sourceLabel?: string;
}

const CONNECTION_TEXT: Record<Connection, string> = {
  open: "Market connected",
  connecting: "Connecting to the market…",
  closed: "Market unreachable, retrying",
};

export function Header({ connection, workersOnline, balance, mode, sourceLabel }: Props) {
  return (
    <header className="header">
      <div className="brand">
        <h1>Pekkah</h1>
        <p className="tagline">
          Idle machines sell compute per job to AI agents. Paid with x402 on Cardano preprod.
        </p>
      </div>
      <div className="chips">
        {sourceLabel ? <span className="chip warn">{sourceLabel}</span> : null}
        <span className={`chip ${connection === "open" ? "good" : "warn"}`} aria-live="polite">
          <span className="dot" />
          {CONNECTION_TEXT[connection]}
        </span>
        <span className="chip">
          {workersOnline} worker{workersOnline === 1 ? "" : "s"} online
        </span>
        {balance ? (
          <span className="chip" title="My agent's wallet, from its last balance report">
            My agent: {formatAsset(balance.data.assetAtomic)} ·{" "}
            {formatAdaRounded(balance.data.lovelace)}
          </span>
        ) : null}
        <ModeChip mode={mode} />
      </div>
    </header>
  );
}

function ModeChip({ mode }: { mode: ViewMode }) {
  if (mode.kind === "live") {
    return (
      <span className={`chip ${mode.running ? "live" : "good"}`}>
        <span className="dot" />
        {mode.running
          ? "Live run"
          : `Live run, finished at ${mode.at ? formatClock(mode.at) : "—"}`}
      </span>
    );
  }
  if (mode.kind === "replay") {
    return <span className="chip info">Replay of a real run at {formatClock(mode.at)}</span>;
  }
  return <span className="chip">No run yet</span>;
}
