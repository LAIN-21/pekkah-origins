import type { JobKind, WorkloadName } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";

export interface JobContext<P> {
  jobId: string;
  kind: JobKind;
  params: P;
  deadlineSec: number;
  /** Aborted on cancel, on deadline + 10 s, or when the market connection drops. */
  signal: AbortSignal;
  progress(pct: number, note?: string): void;
  log: Logger;
}

export interface JobOutput {
  mime: string;
  data: Buffer;
}

/**
 * A workload the worker can sell (section 8). It is offered only while `ready()` is true,
 * which keeps the worker's `warm[]` honest.
 */
export interface Workload<P = unknown> {
  name: WorkloadName;
  /** zod validation of the market's params; throws on anything else. */
  validate(params: unknown): P;
  ready(): Promise<boolean>;
  run(ctx: JobContext<P>): Promise<JobOutput>;
}
