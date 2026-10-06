import type { RequestHandler } from "express";

/**
 * A fixed-window limit per client IP (behind Caddy, req.ip comes from X-Forwarded-For because
 * the app trusts private proxies). Answers 429 with Retry-After.
 */
export function rateLimit(perMinute: number, now: () => number = Date.now): RequestHandler {
  const windows = new Map<string, { start: number; count: number }>();
  return (req, res, next) => {
    const t = now();
    const key = req.ip ?? "unknown";
    let w = windows.get(key);
    if (!w || t - w.start >= 60_000) {
      w = { start: t, count: 0 };
      windows.set(key, w);
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (t - v.start >= 60_000) windows.delete(k);
      }
    }
    w.count += 1;
    if (w.count > perMinute) {
      res.set("Retry-After", String(Math.ceil((w.start + 60_000 - t) / 1000)));
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };
}
