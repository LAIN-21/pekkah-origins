import type { Job, JobResultBody, WorkloadName } from "@pekkah/protocol";

/** What the market keeps per paid job. The result is readable only once the payment settled. */
export interface PaidJob {
  jobId: string;
  offerId: string;
  runId?: string;
  workerId: string;
  workload: WorkloadName;
  txHash: string;
  status: Job["status"];
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  sha256?: string;
  mime?: string;
  data?: Buffer;
  paid: boolean;
  error?: string;
  /** Resolves when the job ends; a resumed request awaits it instead of dispatching again. */
  done: Promise<void>;
}

export class JobStore {
  private readonly jobs = new Map<string, PaidJob>();
  private readonly byTx = new Map<string, string>();

  add(job: PaidJob): void {
    this.jobs.set(job.jobId, job);
    this.byTx.set(job.txHash, job.jobId);
    this.trim();
  }

  get(jobId: string): PaidJob | undefined {
    return this.jobs.get(jobId);
  }

  byTxHash(txHash: string): PaidJob | undefined {
    const id = this.byTx.get(txHash);
    return id ? this.jobs.get(id) : undefined;
  }

  /** Keeps the newest 200 jobs, results included (a 1024² PNG is about 1.5 MB). */
  private trim(): void {
    while (this.jobs.size > 200) {
      const [oldest] = this.jobs.keys();
      if (oldest === undefined) return;
      const job = this.jobs.get(oldest);
      this.jobs.delete(oldest);
      if (job && this.byTx.get(job.txHash) === oldest) this.byTx.delete(job.txHash);
    }
  }
}

export function jobView(job: PaidJob): Job {
  return {
    jobId: job.jobId,
    offerId: job.offerId,
    ...(job.runId ? { runId: job.runId } : {}),
    workerId: job.workerId,
    txHash: job.txHash,
    status: job.status,
    startedAt: job.startedAt,
    ...(job.endedAt ? { endedAt: job.endedAt } : {}),
    ...(job.durationMs !== undefined ? { durationMs: job.durationMs } : {}),
    ...(job.sha256 ? { sha256: job.sha256 } : {}),
    ...(job.mime ? { mime: job.mime } : {}),
    paid: job.paid,
    ...(job.error ? { error: job.error } : {}),
  };
}

export function resultBody(job: PaidJob): JobResultBody {
  return {
    jobId: job.jobId,
    workerId: job.workerId,
    workload: job.workload,
    durationMs: job.durationMs ?? 0,
    sha256: job.sha256 ?? "",
    mime: job.mime ?? "application/octet-stream",
    resultUrl: `/api/results/${job.jobId}`,
    txHash: job.txHash,
  };
}
