import { explorerTxUrl, type JobEventInput } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import type { SubmitResultInput, SubmitResultOutcome } from "./result-submit.js";

export interface EscrowResults {
  submit(input: SubmitResultInput): Promise<SubmitResultOutcome>;
  /** Whether the facilitator sees the transaction on chain. */
  txFound(txHash: string): Promise<boolean>;
  pollMs?: number;
  polls?: number;
}

export interface PublishResultInput {
  key: string;
  jobId: string;
  lockTxHash: string;
  outputIndex: number;
  /** sha256 of the delivered result. */
  resultHash: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the facilitator sees `txHash` on chain within `polls` polls, `pollMs` apart. */
export async function waitForTx(
  txFound: (txHash: string) => Promise<boolean>,
  txHash: string,
  pollMs = 5_000,
  polls = 36,
): Promise<boolean> {
  for (let i = 0; i < polls; i++) {
    await sleep(pollMs);
    if (await txFound(txHash).catch(() => false)) return true;
  }
  return false;
}

/**
 * After an escrow job's lock lands (PR-10b): submit the delivered result's hash as the seller,
 * then report escrow.result_submitted once the chain shows it (polls 5 s apart, 3 minutes at
 * most). The funds stay locked in escrow; nothing here releases them.
 */
export function createResultPublisher(
  o: EscrowResults & {
    emit: (key: string, event: Omit<JobEventInput, "source">) => void;
    log: Logger;
  },
) {
  const pollMs = o.pollMs ?? 5_000;
  const polls = o.polls ?? 36;
  return (input: PublishResultInput): void => {
    void (async () => {
      const { lockTxHash, resultHash } = input;
      const outcome = await o.submit({ lockTxHash, outputIndex: input.outputIndex, resultHash });
      if (!outcome.ok) {
        o.log.warn({ lockTxHash, reason: outcome.reason }, "escrow result not submitted");
        return;
      }
      o.log.info(
        { lockTxHash, txHash: outcome.txHash, feeLovelace: outcome.feeLovelace },
        "escrow result submitted; the funds stay locked in escrow",
      );
      if (await waitForTx(o.txFound, outcome.txHash, pollMs, polls)) {
        o.emit(input.key, {
          type: "escrow.result_submitted",
          jobId: input.jobId,
          data: {
            lockTxHash,
            txHash: outcome.txHash,
            resultHash,
            explorerUrl: explorerTxUrl(outcome.txHash),
          },
        });
        return;
      }
      o.log.warn({ lockTxHash, txHash: outcome.txHash }, "escrow result not seen on chain in time");
    })();
  };
}
