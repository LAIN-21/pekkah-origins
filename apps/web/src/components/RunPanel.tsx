import {
  type DemoState,
  IMAGE_PROMPTS,
  PUBLIC_SCENARIOS,
  type PublicScenario,
  SCENARIOS,
} from "@pekkah/protocol";
import { useState } from "react";
import type { DemoRunResult } from "../api";
import { useNow } from "../hooks";
import type { Connection } from "../store";

interface Props {
  demo: DemoState | null;
  connection: Connection;
  onStart: (scenario: PublicScenario, promptIndex?: number) => Promise<DemoRunResult>;
}

export function RunPanel({ demo, connection, onStart }: Props) {
  const now = useNow(1000);
  const [promptIndex, setPromptIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const cooldownLeft = demo?.cooldownUntil
    ? Math.max(0, Math.ceil((Date.parse(demo.cooldownUntil) - now) / 1000))
    : 0;
  const blocked =
    connection !== "open" ||
    !demo ||
    demo.running ||
    cooldownLeft > 0 ||
    demo.runsLeftToday === 0 ||
    pending;

  const status = !demo
    ? "Waiting for the market…"
    : demo.running
      ? "A run is in progress. Watch it below."
      : cooldownLeft > 0
        ? `Next run in ${Math.floor(cooldownLeft / 60)}:${String(cooldownLeft % 60).padStart(2, "0")}`
        : demo.runsLeftToday === 0
          ? "No runs left today."
          : `${demo.runsLeftToday} run${demo.runsLeftToday === 1 ? "" : "s"} left today.`;

  const start = async (scenario: PublicScenario) => {
    setPending(true);
    setMessage(null);
    const result = await onStart(scenario, scenario === "gpu-image" ? promptIndex : undefined);
    setPending(false);
    if (!result.ok) setMessage(result.message);
  };

  return (
    <section className="panel" aria-labelledby="run-title">
      <h2 id="run-title">Ask my agent to buy a job</h2>
      <p className="muted small">
        Each run is real: my agent pays a worker in test tUSDM on Cardano preprod, and only after
        the job delivers.
      </p>
      <div className="scenarios">
        {PUBLIC_SCENARIOS.map((name) => (
          <div key={name} className="scenario">
            <button type="button" disabled={blocked} onClick={() => start(name)}>
              {SCENARIOS[name].title}
            </button>
            <p className="small muted">{SCENARIOS[name].summary}</p>
            {name === "gpu-image" ? (
              <label className="small">
                Prompt{" "}
                <select
                  value={promptIndex}
                  onChange={(e) => setPromptIndex(Number(e.target.value))}
                  disabled={blocked}
                >
                  {IMAGE_PROMPTS.map((p, i) => (
                    <option key={p} value={i}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        ))}
      </div>
      <p className="small run-status" aria-live="polite">
        {status}
      </p>
      <p className="small bad" aria-live="polite">
        {message ?? ""}
      </p>
    </section>
  );
}
