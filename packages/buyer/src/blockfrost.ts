// The buyer's own Blockfrost reads: its balance, and whether a settled transaction is visible.
// Polls stay at least 5 s apart (CLAUDE.md, Payments safety).

export interface BlockfrostConfig {
  baseUrl: string;
  projectId: string;
}

export const MIN_POLL_MS = 5_000;

async function get(config: BlockfrostConfig, path: string): Promise<Response> {
  return fetch(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
    headers: { project_id: config.projectId },
    signal: AbortSignal.timeout(15_000),
  });
}

export interface Balance {
  lovelace: string;
  assetAtomic: string;
}

/** `asset` is `<policyId>.<assetNameHex>`; Blockfrost's unit is the same without the dot. */
export async function addressBalance(
  config: BlockfrostConfig,
  address: string,
  asset: string,
): Promise<Balance> {
  const res = await get(config, `/addresses/${address}`);
  if (res.status === 404) return { lovelace: "0", assetAtomic: "0" };
  if (!res.ok) throw new Error(`Blockfrost /addresses answered ${res.status}`);
  const body = (await res.json()) as { amount?: { unit: string; quantity: string }[] };
  const unit = asset.replace(".", "");
  const find = (u: string) => body.amount?.find((a) => a.unit === u)?.quantity ?? "0";
  return { lovelace: find("lovelace"), assetAtomic: find(unit) };
}

export interface TxSighting {
  found: boolean;
  block?: string;
  blockHeight?: number;
}

export async function txSighting(config: BlockfrostConfig, txHash: string): Promise<TxSighting> {
  const res = await get(config, `/txs/${txHash}`);
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error(`Blockfrost /txs answered ${res.status}`);
  const body = (await res.json()) as { block?: string; block_height?: number };
  return {
    found: true,
    ...(body.block ? { block: body.block } : {}),
    ...(typeof body.block_height === "number" ? { blockHeight: body.block_height } : {}),
  };
}

/** Polls every `intervalMs` (at least 5 s) until Blockfrost shows the transaction. */
export async function waitForTx(
  config: BlockfrostConfig,
  txHash: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<TxSighting> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const interval = Math.max(options.intervalMs ?? MIN_POLL_MS, MIN_POLL_MS);
  for (;;) {
    try {
      const sighting = await txSighting(config, txHash);
      if (sighting.found) return sighting;
    } catch {
      // A failed lookup is retried at the next poll.
    }
    if (Date.now() + interval > deadline) return { found: false };
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
