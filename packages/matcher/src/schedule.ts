// Live hours: `HH:MM-HH:MM Area/City`, e.g. `09:00-23:00 Asia/Singapore`. A range that ends
// before it starts runs overnight (`22:00-06:00`).

export interface Schedule {
  startMin: number;
  endMin: number;
  timeZone: string;
}

const PATTERN = /^\s*(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})\s+(\S+)\s*$/;

export function parseSchedule(text: string): Schedule | null {
  const m = PATTERN.exec(text);
  if (!m) return null;
  const [h1, m1, h2, m2] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  if (h1 > 23 || h2 > 24 || m1 > 59 || m2 > 59) return null;
  const timeZone = m[5] as string;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
  } catch {
    return null;
  }
  return { startMin: h1 * 60 + m1, endMin: h2 * 60 + m2, timeZone };
}

function minutesIn(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** An unreadable schedule never blocks a worker: it is treated as always open. */
export function withinSchedule(text: string | undefined, now: Date): boolean {
  if (!text) return true;
  const schedule = parseSchedule(text);
  if (!schedule) return true;
  const t = minutesIn(schedule.timeZone, now);
  const { startMin, endMin } = schedule;
  if (startMin === endMin) return true;
  return startMin < endMin ? t >= startMin && t < endMin : t >= startMin || t < endMin;
}
