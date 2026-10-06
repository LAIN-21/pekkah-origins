import {
  explorerAddressUrl,
  formatUsd,
  type WorkerSnapshot,
  type WorkloadName,
} from "@pekkah/protocol";
import { formatSeconds, short } from "../format";

const WORKLOAD_LABEL: Record<WorkloadName, string> = { image: "image", fractal: "CPU render" };

const STATUS: Record<WorkerSnapshot["status"], { text: string; tone: string }> = {
  online: { text: "online", tone: "good" },
  busy: { text: "busy", tone: "info" },
  calibrating: { text: "measuring", tone: "warn" },
  offline: { text: "offline", tone: "muted" },
  untrusted: { text: "failed its check", tone: "bad" },
};

/** A worker the market sells. Before PR-13 the market didn't send `selling`: all of them sold. */
export function isSelling(w: WorkerSnapshot): boolean {
  return w.selling !== false;
}

export function MarketPanel({ workers }: { workers: WorkerSnapshot[] }) {
  const selling = workers.filter(isSelling);
  const joining = workers.filter((w) => !isSelling(w));
  return (
    <section className="panel" aria-labelledby="market-title">
      <h2 id="market-title">Who sells</h2>
      {selling.length === 0 ? (
        <p className="muted">No worker has connected yet.</p>
      ) : (
        <div className="workers">
          {selling.map((w) => (
            <WorkerCard key={w.workerId} worker={w} />
          ))}
        </div>
      )}
      {joining.length > 0 ? (
        <div className="joining">
          <h3>Joining the network</h3>
          <p className="small muted">
            On probation: listed and measured, but they sell nothing until I allowlist them.
          </p>
          <div className="workers">
            {joining.map((w) => (
              <WorkerCard key={w.workerId} worker={w} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function hardwareShort(w: WorkerSnapshot): string {
  const gpu = w.hardware.gpu;
  return gpu
    ? `${gpu.name.replace(/^NVIDIA /, "")}, ${gpu.vramGb} GB`
    : `${w.hardware.vcpus} vCPU, ${w.hardware.memGb} GB RAM`;
}

/** The market in a few lines, beside a live run. */
export function MarketStrip({ workers }: { workers: WorkerSnapshot[] }) {
  const selling = workers.filter(isSelling);
  const joining = workers.length - selling.length;
  return (
    <section className="card strip" aria-label="Who sells">
      <h3>Who sells</h3>
      {selling.length === 0 ? <p className="small muted">No worker has connected yet.</p> : null}
      <ul className="strip-list">
        {selling.map((w) => {
          const status = STATUS[w.status];
          const busy = w.util?.gpuPct ?? w.util?.cpuPct;
          return (
            <li key={w.workerId} className={w.status}>
              <span className="strip-name">{w.name}</span>
              <span className="strip-hw">{hardwareShort(w)}</span>
              <span className={`chip tiny ${status.tone}`}>{status.text}</span>
              {busy !== undefined ? (
                <span className="strip-util">
                  {w.util?.gpuPct !== undefined ? "GPU" : "CPU"} {Math.round(busy)}%
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {joining > 0 ? (
        <p className="small muted">{joining} joining on probation, not selling.</p>
      ) : null}
    </section>
  );
}

function WorkerCard({ worker: w }: { worker: WorkerSnapshot }) {
  const status = STATUS[w.status];
  const gpu = w.hardware.gpu;
  return (
    <article className={`card worker ${w.status}`}>
      <div className="row between">
        {/* A probation worker goes by the market's display id, never a name it sent. */}
        <h3>{isSelling(w) ? w.name : w.workerId}</h3>
        <span className={`chip ${status.tone}`}>
          <span className="dot" />
          {status.text}
        </span>
      </div>
      {w.escrowSeller ? (
        <span className="chip tiny info escrow-chip">sells through escrow</span>
      ) : null}
      <p className="hardware">
        <span className="label">Reported by the machine</span>
        {gpu ? (
          <>
            <strong>{gpu.name.replace(/^NVIDIA /, "")}</strong> · {gpu.vramGb} GB VRAM
            <br />
          </>
        ) : null}
        {w.hardware.vcpus} vCPU · {w.hardware.memGb} GB RAM
      </p>
      <ul className="prices">
        {w.prices.map((p) => {
          const warm = w.warm.includes(p.workload);
          return (
            <li key={p.workload} className={warm ? "" : "cold"}>
              <span>{WORKLOAD_LABEL[p.workload]}</span>
              <span>
                {formatUsd(p.usd)}
                {warm ? "" : " (not ready)"}
              </span>
            </li>
          );
        })}
      </ul>
      <Measured worker={w} />
      <Utilisation worker={w} />
      <p className="payto">
        Paid to{" "}
        <a href={explorerAddressUrl(w.payTo)} target="_blank" rel="noreferrer">
          {short(w.payTo, 12, 6)}
        </a>
      </p>
    </article>
  );
}

function Measured({ worker: w }: { worker: WorkerSnapshot }) {
  const f = w.calibration.fractal;
  const img = w.calibration.image;
  if (!f && !img) return <p className="measured muted">Not measured yet</p>;
  return (
    <ul className="measured">
      <li className="label">Measured by the market</li>
      {f ? (
        <li className={f.verified ? "good" : "bad"}>
          {f.verified
            ? `CPU render in ${formatSeconds(f.calibSec)} ✓ (answer checked)`
            : `CPU render in ${formatSeconds(f.calibSec)} ✗ (wrong answer)`}
        </li>
      ) : null}
      {img ? <li>1024² image in {formatSeconds(img.secImage1024x4)} (timed)</li> : null}
    </ul>
  );
}

function Utilisation({ worker: w }: { worker: WorkerSnapshot }) {
  const u = w.util;
  if (!u) return null;
  const vramTotal = w.hardware.gpu?.vramGb;
  return (
    <div className="util">
      <Bar label="CPU" pct={u.cpuPct} />
      {u.gpuPct !== undefined ? <Bar label="GPU" pct={u.gpuPct} /> : null}
      {u.vramUsedGb !== undefined && vramTotal ? (
        <Bar
          label="VRAM"
          pct={(u.vramUsedGb / vramTotal) * 100}
          text={`${u.vramUsedGb.toFixed(1)} / ${vramTotal} GB`}
        />
      ) : null}
    </div>
  );
}

function Bar({ label, pct, text }: { label: string; pct: number; text?: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="bar">
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className="bar-fill" style={{ width: `${clamped}%` }} />
      </span>
      <span className="bar-text">{text ?? `${Math.round(clamped)}%`}</span>
    </div>
  );
}
