import type { TxStatus } from "@pekkah/protocol";

export interface BlockfrostConfig {
  baseUrl: string;
  projectId: string;
}

async function get(config: BlockfrostConfig, path: string): Promise<Response> {
  return fetch(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
    headers: { project_id: config.projectId },
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * found: false means no block Blockfrost has indexed holds the transaction yet. Given the
 * transaction's TTL slot, `final: true` says the chain is past it, so it can never land.
 */
export async function lookupTx(
  config: BlockfrostConfig,
  txHash: string,
  ttlSlot?: bigint,
): Promise<TxStatus> {
  const res = await get(config, `/txs/${txHash}`);
  if (res.status === 404) {
    if (ttlSlot === undefined) return { found: false };
    const latest = await get(config, "/blocks/latest");
    if (!latest.ok) throw new Error(`Blockfrost /blocks/latest answered ${latest.status}`);
    const { slot } = (await latest.json()) as { slot?: number };
    // The TTL is exclusive: from that slot on, the transaction can no longer be included.
    return { found: false, final: typeof slot === "number" && BigInt(slot) >= ttlSlot };
  }
  if (!res.ok) throw new Error(`Blockfrost /txs answered ${res.status}`);
  const tx = (await res.json()) as { block?: string; block_height?: number };
  const latest = await get(config, "/blocks/latest");
  let confirmations: number | undefined;
  if (latest.ok && typeof tx.block_height === "number") {
    const { height } = (await latest.json()) as { height?: number };
    if (typeof height === "number") confirmations = Math.max(0, height - tx.block_height);
  }
  return {
    found: true,
    ...(tx.block ? { block: tx.block } : {}),
    ...(confirmations !== undefined ? { confirmations } : {}),
  };
}
