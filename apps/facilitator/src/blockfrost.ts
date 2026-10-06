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

/** found: false means Blockfrost has never seen the transaction. */
export async function lookupTx(config: BlockfrostConfig, txHash: string): Promise<TxStatus> {
  const res = await get(config, `/txs/${txHash}`);
  if (res.status === 404) return { found: false };
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
