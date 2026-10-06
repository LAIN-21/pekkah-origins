import type { PublicScenario, RunLog } from "@pekkah/protocol";
import { type DemoRunResult, fetchLatestRun, fetchRun, startDemoRun } from "./api";
import { connectFeed, type FeedHandlers } from "./feed";

/** Where the page's data comes from: the market, or (dev builds only) a fixture. */
export interface FeedSource {
  connect(handlers: FeedHandlers): () => void;
  latestRun(): Promise<RunLog | null>;
  /** One run by its id, for ?run=. Null when the market doesn't have it. */
  fetchRun(runId: string): Promise<RunLog | null>;
  startRun(scenario: PublicScenario, promptIndex?: number): Promise<DemoRunResult>;
  /** Shown in the header when the data isn't from a real market. */
  label?: string;
}

export const marketSource: FeedSource = {
  connect: connectFeed,
  latestRun: fetchLatestRun,
  fetchRun,
  startRun: startDemoRun,
};
