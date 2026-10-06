// Shared constants. This package also ships in the web bundle: nothing private goes here
// (the agent's ceilings live only in apps/agent).

export const PEKKAH_VERSION = "0.1.0";

export const NETWORK = "cardano:preprod" as const;
export type Network = typeof NETWORK;

/** tUSDM on preprod (policy e675b46e…), the same value as USDM_PREPROD_ASSET in @x402/cardano. PEKKAH_ASSET overrides it. */
export const DEFAULT_ASSET =
  "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
export const ASSET_SYMBOL = "tUSDM";
export const ASSET_DECIMALS = 6;
export const LOVELACE_DECIMALS = 6;

export const EXPLORER_BASE_URL = "https://preprod.cardanoscan.io";

export function explorerTxUrl(txHash: string): string {
  return `${EXPLORER_BASE_URL}/transaction/${txHash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_BASE_URL}/address/${address}`;
}

/** The agent sends this on its quote and job requests; the market tags everything that follows. */
export const RUN_ID_HEADER = "X-Pekkah-Run-Id";

/** Block inclusion: about 20 s on preprod, with gaps of up to about 80 s. */
export const L1_CONFIRMATIONS = 0;
/** The signed transaction's validity window. The job and the settlement must both fit inside it. */
export const MAX_TIMEOUT_SECONDS = 600;
/** Offers are single use and expire this long after the quote. */
export const OFFER_TTL_SEC = 120;

export const DEADLINE_MIN_SEC = 5;
/** The job plus up to ~160 s of settling must fit the 600 s validity window. */
export const DEADLINE_MAX_SEC = 120;
/** Calibration jobs may take longer than a paid job's deadline on a slow machine. */
export const CALIBRATION_DEADLINE_SEC = 120;
/** The worker kills a job container at deadline + this. */
export const JOB_KILL_GRACE_SEC = 10;
/** The market waits for a result until deadline + this. */
export const RESULT_WAIT_GRACE_SEC = 15;

export const HEARTBEAT_MS = 5_000;
export const HEARTBEAT_BUSY_MS = 2_000;
/** A worker silent for this long is offline. */
export const WORKER_SILENT_MS = 15_000;
export const RECONNECT_INITIAL_MS = 1_000;
export const RECONNECT_MAX_MS = 5_000;

export const WS_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
/** Base64 of the result must fit the WebSocket limit. */
export const RESULT_MAX_BYTES = 20 * 1024 * 1024;

export const PROMPT_MAX_CHARS = 300;

/**
 * Bounds on what a worker reports in its hello (PLAN2 PR-13). The three live workers' hellos
 * fit them unchanged; a worker trims its strings to them before sending.
 */
export const HELLO_LIMITS = {
  name: 64,
  cpuModel: 80,
  gpuName: 64,
  driver: 32,
  version: 64,
  schedule: 64,
  prices: 4,
} as const;

/**
 * The wording for a Masumi lock until an escrow.released event exists for it (CLAUDE.md rule 4):
 * locked in escrow, never paid or released. Since PR-16 the seller collects after the unlock.
 * No apostrophes: the UI's tests look for it in HTML, which escapes them.
 */
export const MASUMI_LOCK_LABEL =
  "Locked in Masumi escrow until the unlock time. Then the seller collects the price and the collateral goes back to the buyer. Dispute is my next step.";
/** Only once an escrow.released event exists for the lock (CLAUDE.md rule 4). */
export const MASUMI_RELEASED_LABEL =
  "Released from Masumi escrow: the seller collected the price, and the buyer's collateral came back.";
/** Only once an escrow.refunded event exists for the lock (CLAUDE.md rule 4). */
export const MASUMI_REFUNDED_LABEL =
  "Refunded from Masumi escrow: the price and the collateral went back to the buyer.";
