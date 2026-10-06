import { pino } from "pino";

/** Any key that matches is redacted, at any depth (CLAUDE.md, Secrets). */
export const SECRET_KEY = /mnemonic|token|secret|project_?id|authorization/i;
export const REDACTED = "[redacted]";

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return "[depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  if (value instanceof Error) {
    return { type: value.name, message: value.message, stack: value.stack };
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

export type Logger = pino.Logger;

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL || "info",
    formatters: {
      bindings: (bindings) => redact(bindings) as Record<string, unknown>,
      log: (object) => redact(object) as Record<string, unknown>,
    },
  });
}
