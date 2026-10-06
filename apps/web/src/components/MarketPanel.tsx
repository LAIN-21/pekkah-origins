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

export function MarketPanel({ workers }: { workers: WorkerSnapshot[] }) {
  return (
    <section className="panel" aria-labelledby="market-title">
      <h2 id="market-title">Who sells</h2>
      {workers.length === 0 ? (
        <p className="muted">No worker has connected yet.</p>
      ) : (
        <div className="workers">
          {workers.map((w) => (
            <WorkerCard key={w.workerId} worker={w} />
          ))}
        </div>
      )}
    </section>
  );
}

function WorkerCard({ worker: w }: { worker: WorkerSnapshot }) {
  const status = STATUS[w.status];
  const gpu = w.hardware.gpu;
  return (
    <article className={`card worker ${w.status}`}>
      <div className="row between">
        <h3>{w.name}</h3>
        <span className={`chip ${status.tone}`}>
          <span className="dot" />
          {status.text}
        </span>
      </div>
      <p className="hardware">
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
      {f ? (
        <li className={f.verified ? "good" : "bad"}>
          {f.verified
            ? `Measured ${formatSeconds(f.calibSec)} ✓ (answer checked)`
            : `Measured ${formatSeconds(f.calibSec)} ✗ (wrong answer)`}
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
