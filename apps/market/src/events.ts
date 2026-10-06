import { JobEvent, type JobEventInput } from "@pekkah/protocol";
import type { Logger } from "@pekkah/runtime";
import { monotonicFactory } from "ulid";

const nextId = monotonicFactory();

/**
 * The market's event bus. Ids are monotonic ulids, so events sort in the order they were
 * emitted. Every event is validated against the protocol before it goes out: an event the
 * protocol can't describe is logged and dropped, never shown.
 */
export class EventBus {
  private readonly recent: JobEvent[] = [];
  private readonly listeners = new Set<(event: JobEvent) => void>();

  constructor(
    private readonly log: Logger,
    private readonly keep = 500,
  ) {}

  emit(input: JobEventInput): JobEvent | null {
    const parsed = JobEvent.safeParse({ ...input, id: nextId(), ts: new Date().toISOString() });
    if (!parsed.success) {
      this.log.error({ type: input.type, issues: parsed.error.issues }, "invalid event dropped");
      return null;
    }
    const event = parsed.data;
    this.recent.push(event);
    if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.error({ err }, "event listener failed");
      }
    }
    return event;
  }

  subscribe(listener: (event: JobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  latest(limit = 100): JobEvent[] {
    return this.recent.slice(-limit);
  }
}
