import {
  ASSET_SYMBOL,
  type ComputeRequest,
  formatAtomic,
  formatLovelace,
  formatUsd,
} from "@pekkah/protocol";

export { formatLovelace, formatUsd };

/** "50000" → "0.05 tUSDM". */
export function formatAsset(atomic: string): string {
  return `${formatAtomic(atomic)} ${ASSET_SYMBOL}`;
}

/** A rounded tADA amount for at-a-glance display, e.g. "9318.46 tADA". Receipts use formatLovelace. */
export function formatAdaRounded(lovelace: string, digits = 2): string {
  return `${(Number(lovelace) / 1_000_000).toFixed(digits)} tADA`;
}

/** First and last characters of a hash or address. */
export function short(value: string, head = 8, tail = 6): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** 6.85 → "6.9 s"; 95 → "95 s"; 125 → "2 min 5 s". */
export function formatSeconds(sec: number): string {
  if (sec < 10) return `${sec.toFixed(1)} s`;
  if (sec < 90) return `${Math.round(sec)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function formatMs(ms: number): string {
  return formatSeconds(ms / 1000);
}

/** Local wall-clock time, HH:MM. */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Local wall-clock time, HH:MM:SS. */
export function formatClockSeconds(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Time from `fromIso` to `toIso`: "+12.4 s", or "+33:07" from 100 s on (an escrow's release). */
export function formatElapsed(fromIso: string, toIso: string): string {
  const sec = Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / 1000);
  if (sec < 100) return `+${sec.toFixed(1)} s`;
  return `+${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

/** POSIX milliseconds (Masumi terms) → local date and time. */
export function formatPosixMs(ms: string): string {
  return new Date(Number(ms)).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** What a request asks for, in a few words: "An image: “a lighthouse at dusk”". */
export function requestWhat(r: ComputeRequest): string {
  return r.workload === "image"
    ? `An image: “${r.params.prompt}”`
    : `A CPU render (preset ${r.params.preset})`;
}

/** A request's terms on one line: size, hardware, deadline and budget. */
export function requestLine(r: ComputeRequest): string {
  const parts: string[] = [];
  if (r.workload === "image") parts.push(`${r.params.size}², ${r.params.steps} steps`);
  if (r.constraints.gpu)
    parts.push(`GPU${r.constraints.minVramGb ? ` ≥ ${r.constraints.minVramGb} GB` : ""}`);
  parts.push(`deadline ${r.constraints.deadlineSec} s`);
  parts.push(`budget ${formatUsd(r.budget.maxUsd)}`);
  if (r.constraints.exclude?.length) parts.push(`not ${r.constraints.exclude.join(", ")}`);
  return parts.join(" · ");
}
