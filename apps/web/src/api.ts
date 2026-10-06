import { ApiError, DemoRunAccepted, type PublicScenario, RunLog } from "@pekkah/protocol";

/** The last real run, for the replay. Null when there is none yet. */
export async function fetchLatestRun(): Promise<RunLog | null> {
  const res = await fetch("/api/runs/latest");
  if (!res.ok) return null;
  const parsed = RunLog.safeParse(await res.json());
  return parsed.success ? parsed.data : null;
}

export type DemoRunResult =
  | { ok: true; runId: string }
  | { ok: false; status: number; message: string };

const FALLBACK_MESSAGES: Record<number, string> = {
  403: "This scenario can't be started from the page.",
  404: "The run button isn't available on this market yet.",
  409: "A run is already in progress.",
  429: "The run button is cooling down. Try again shortly.",
};

/** POST /api/demo/run: the market starts a real paid run through my agent. */
export async function startDemoRun(
  scenario: PublicScenario,
  promptIndex?: number,
): Promise<DemoRunResult> {
  let res: Response;
  try {
    res = await fetch("/api/demo/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(promptIndex === undefined ? { scenario } : { scenario, promptIndex }),
    });
  } catch {
    return { ok: false, status: 0, message: "The market can't be reached." };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 202) {
    const accepted = DemoRunAccepted.safeParse(body);
    if (accepted.success) return { ok: true, runId: accepted.data.runId };
  }
  const error = ApiError.safeParse(body);
  const message =
    (error.success && (error.data.message ?? error.data.error)) ||
    FALLBACK_MESSAGES[res.status] ||
    `The market answered ${res.status}.`;
  return { ok: false, status: res.status, message };
}
