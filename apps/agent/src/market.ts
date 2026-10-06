import {
  type AgentEventType,
  type ComputeRequest,
  type EventData,
  Quote,
  RUN_ID_HEADER,
} from "@pekkah/protocol";

/** The agent's view of the market: quotes, results and its own events (PLAN 5.2, 5.4). */
export class MarketClient {
  constructor(
    readonly url: string,
    private readonly agentToken: string | undefined,
    private readonly warn: (message: string) => void,
  ) {}

  async quote(request: ComputeRequest, runId: string): Promise<Quote> {
    const res = await fetch(`${this.url}/api/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", [RUN_ID_HEADER]: runId },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`quote failed: HTTP ${res.status} ${await res.text()}`);
    return Quote.parse(await res.json());
  }

  async result(resultUrl: string): Promise<Buffer | null> {
    const res = await fetch(`${this.url}${resultUrl}`, { signal: AbortSignal.timeout(30_000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }

  /**
   * Posts one agent event and waits for the market to take it, so it lands on the bus before
   * whatever the agent does next (the UI shows events in the order they happened). A failure
   * is reported, never fatal: the payment flow does not depend on the UI.
   */
  async event<T extends AgentEventType>(
    type: T,
    data: EventData<T>,
    ids: { runId: string; jobId?: string },
  ): Promise<void> {
    if (!this.agentToken) return;
    try {
      const res = await fetch(`${this.url}/api/agent-events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.agentToken}`,
        },
        body: JSON.stringify({ events: [{ type, data, ...ids }] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.warn(`agent event ${type} refused: HTTP ${res.status}`);
    } catch (err) {
      this.warn(`agent event ${type} not delivered: ${err instanceof Error ? err.message : err}`);
    }
  }
}
