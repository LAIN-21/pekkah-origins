import { pathToFileURL } from "node:url";
import { PUBLIC_SCENARIOS, SCENARIOS } from "@pekkah/protocol";

// install-smoke: the three public scenario quotes, before and while a probation worker is
// connected. `tsx src/smoke-quotes.ts <market URL>` prints them; the workflow diffs the two.

const VOLATILE = new Set(["quoteId", "offerId", "expiresAt", "runId"]);

/** A quote without its ids and times: everything that must not change when a worker joins. */
export function quoteShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(quoteShape);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE.has(key))
      .map(([key, v]) => [key, quoteShape(v)]),
  );
}

export async function publicQuotes(market: string, fetchImpl: typeof fetch = fetch) {
  const out: Record<string, unknown> = {};
  for (const name of PUBLIC_SCENARIOS) {
    const res = await fetchImpl(new URL("/api/quote", market), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(SCENARIOS[name].request),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${name}: POST /api/quote answered ${res.status}`);
    out[name] = quoteShape(await res.json());
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const market = process.argv[2];
  if (!market) {
    console.error("usage: tsx src/smoke-quotes.ts <market URL>");
    process.exit(2);
  }
  console.log(JSON.stringify(await publicQuotes(market), null, 2));
}
