import { z } from "zod";
import { JobEvent } from "./events.js";
import { Id, IsoDate } from "./primitives.js";
import { WorkerSnapshot } from "./worker.js";

// Browser WebSocket, /ws/ui (PLAN 5.4). Read-only: a snapshot first, then live messages.

/** The public run button's state. */
export const DemoState = z.object({
  running: z.boolean(),
  /** The run in progress, when `running`. */
  runId: Id.optional(),
  cooldownUntil: IsoDate.nullable(),
  runsLeftToday: z.number().int().nonnegative(),
});
export type DemoState = z.infer<typeof DemoState>;

export const UiSnapshotMsg = z.object({
  type: z.literal("snapshot"),
  workers: z.array(WorkerSnapshot),
  recentEvents: z.array(JobEvent),
  demo: DemoState,
});
export const UiEventMsg = z.object({ type: z.literal("event"), event: JobEvent });
/** At most once a second. */
export const UiWorkersMsg = z.object({
  type: z.literal("workers"),
  workers: z.array(WorkerSnapshot),
});
export const UiDemoMsg = z.object({ type: z.literal("demo"), demo: DemoState });

export const UiMessage = z.discriminatedUnion("type", [
  UiSnapshotMsg,
  UiEventMsg,
  UiWorkersMsg,
  UiDemoMsg,
]);
export type UiMessage = z.infer<typeof UiMessage>;
