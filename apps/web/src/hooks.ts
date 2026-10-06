import type { JobEvent } from "@pekkah/protocol";
import { useCallback, useEffect, useState } from "react";

/** The current time, refreshed every `ms` (for countdowns and elapsed timers). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Gaps between replayed events are kept, but squeezed into this range. */
const REPLAY_MIN_GAP_MS = 250;
const REPLAY_MAX_GAP_MS = 1500;

/**
 * Reveals a finished run's events one by one, at their original pace with long
 * waits shortened. Returns how many to show and a way to start over. When
 * `enabled` is false every event is shown at once.
 */
export function useReplay(
  events: readonly JobEvent[],
  enabled: boolean,
): { shown: number; done: boolean; restart: () => void } {
  const [shown, setShown] = useState(enabled ? Math.min(1, events.length) : events.length);
  const [round, setRound] = useState(0);
  const key = events.length > 0 ? `${events[0]?.runId}:${events.length}` : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: restart on a new run or a restart request
  useEffect(() => {
    if (!enabled) {
      setShown(events.length);
      return;
    }
    let i = Math.min(1, events.length);
    setShown(i);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      if (i >= events.length) return;
      const prev = events[i - 1];
      const cur = events[i];
      const gap = prev && cur ? Date.parse(cur.ts) - Date.parse(prev.ts) : REPLAY_MIN_GAP_MS;
      const wait = Math.min(REPLAY_MAX_GAP_MS, Math.max(REPLAY_MIN_GAP_MS, gap));
      timer = setTimeout(() => {
        i += 1;
        setShown(i);
        next();
      }, wait);
    };
    next();
    return () => clearTimeout(timer);
  }, [key, enabled, round]);

  const restart = useCallback(() => setRound((r) => r + 1), []);
  return { shown, done: shown >= events.length, restart };
}
