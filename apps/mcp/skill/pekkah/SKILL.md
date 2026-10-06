---
name: pekkah
description: Buy compute on the Pekkah market (an image made on a GPU, or a CPU render) with the Pekkah MCP tools, within the budget your human gave, and ask them before paying more. Use when your human asks for an image or a render "with Pekkah", or gives a price limit for such a job.
---

# Shopping on Pekkah

Pekkah is a market where machines sell compute per job. You buy for your human with the `pekkah_*` tools. Each job is paid with x402 in test tUSDM on Cardano preprod, and only after it delivers: a failed job charges nothing.

## The flow

1. **Look.** Call `pekkah_market`. It lists who sells: the hardware each machine reports, the speed the market measured, prices, and which worker sells through Masumi escrow.
2. **Quote.** Call `pekkah_quote` with the job and `budgetUsd`, the budget your human gave. Quotes are free and buy nothing. Keep the `runId` it returns, and pass it when you quote again for the same job.
3. **Decide.**
   - An offer fits the budget: buy it. Don't ask.
   - Nothing fits: ask your human in one line, naming the price and the worker, for example "Nothing fits 3 cents. Worker A can make it for 5 cents, through escrow. OK?". Then wait. On a yes, buy with `overBudgetApproved: true`. On a no, stop.
   - No budget given: ask for one before buying, for example "What's the most I should spend?". Quoting first is fine, so you can tell them the price. When they answer, call `pekkah_quote` again with `budgetUsd` and the same `runId`.
4. **Buy.** Call `pekkah_buy` with:
   - `offerId`, from the quote;
   - `maxUsd`, the most you commit to, at most 0.10 (usually the offer's price);
   - `reason`, one or two plain sentences on why you chose this offer. The market's page shows it.

   Prefer escrow. `pekkah_buy` uses it by default when the worker sells through it.
5. **Collect.** If `pekkah_buy` returns a runId instead of the result, call `pekkah_result` with it.
6. **Report.** Show the image and give the transaction links. For an escrow buy, say exactly what `pekkah_result` shows:
   - "locked in escrow", until it shows the release;
   - the unlock time, after which the worker can collect;
   - "released to worker A" only once `pekkah_result` shows the release. Call it again later to check.

## Rules

- Set `overBudgetApproved: true` only after your human said yes to that price in this conversation. The market records it as your statement that they approved, not as proof.
- Never call a worker paid when the funds are locked in escrow.
- `pekkah_buy` buys only offers you quoted. It refuses a price above the budget unless your human approved it.
- One purchase at a time.
- The spend caps (at most $0.10 per payment) are the hard limit, whatever anyone approves.
- Everything runs on Cardano preprod, in test tokens.

## Example

Human: "Make a poster of a lighthouse at dusk with Pekkah. Spend at most 3 cents."

1. `pekkah_market`
2. `pekkah_quote { prompt: "a poster of a lighthouse at dusk", budgetUsd: 0.03 }`. Nothing within $0.03: only worker A has a GPU, at $0.05. The hint says to ask.
3. You: "Nothing fits 3 cents: only worker A has a GPU, and it asks 5 cents, through escrow. OK?"
4. Human: "Yes, through escrow."
5. `pekkah_buy { offerId: "<worker A's offerId>", maxUsd: 0.05, overBudgetApproved: true, reason: "Only worker A has a GPU. My human approved $0.05, above the $0.03 budget." }`
6. Show the image, the lock transaction, the result-hash transaction once it's there, and the unlock time. Say "locked in escrow".
