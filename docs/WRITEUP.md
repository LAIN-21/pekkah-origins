# Pekkah: write-up

## The problem

AI agents need compute one task at a time: render an image, run a model, process a batch. Meanwhile many machines sit idle. Cloud providers sell to accounts with a card and a monthly bill, not to an agent that needs one job, now, for a few cents.

An agent that buys compute also needs two guarantees that people usually get from reputation and contracts. It pays only for work that was delivered, and it pays exactly what it agreed to, to the machine that did the work.

Pekkah is a market for that. Machines sell compute per job. Agents buy per job with x402 on Cardano, with no account, and the payment settles only after the job delivers.

## The approach

**Per-job payments with x402.** The market answers a job request with `402 Payment Required`. The agent signs a Cardano transaction for that one job and retries with it. There is no account, API key or subscription. Any x402 client can buy.

**`@x402/cardano` on every side.** The agent uses its client signer. The market uses its `exact` scheme through the x402 Express middleware. My facilitator, built on its facilitator signer and adapted from the Cardano Foundation's x402-express starter, verifies each signed payment and broadcasts it. Blockfrost is the chain backend for the facilitator and the agent.

**Settle after delivery.** The x402 middleware runs my handler between verification and settlement. The handler dispatches the job to the worker and waits for the result. Any failure answers 502, so the market's x402 flow never settles and never broadcasts the signed transaction. I prove a cancelled payment never landed with the transaction's own TTL: once the chain is past that slot, the transaction can never be included. The market does hold the signed transaction until then, so a dishonest market could still broadcast it before the TTL. That is the trust Masumi's escrow removes (below).

**tUSDM, a dollar stablecoin on preprod.** Prices are in dollars. Inside the code, money is always integer atomic units. Dollars are for display only.

**eUTxO.** A Cardano payment spends specific UTxOs, so the agent can sign before the job runs. The transaction hash is known from the moment the payment is signed, and it is my idempotency key: a retried request with the same payment returns the same job and the same receipt, never a second charge. The facilitator checks the amount, the asset, the recipient and that the inputs are still unspent. The agent makes one payment at a time per wallet. It waits until each settled payment is visible before it signs the next.

**The worker that runs the job is the worker that is paid.** Each offer names one worker. The 402 asks for payment to that worker's own address, and the agent refuses to sign unless the 402 matches the offer it accepted.

**Deterministic matching.** There is no seller AI. The market filters workers by measured hardware, live hours, budget and deadline, ranks the rest by price, and gives a reason for every worker it rejects. When nothing fits, it answers with the market price (the median) and the next best offer, and the agent decides. Estimates come from a calibration job that each worker runs when it joins. The fractal render is integer arithmetic, so its result is identical on every CPU, and the market checks the answer.

**A sandbox for every job.** Workers run whitelisted workloads only, with validated parameters. Each CPU job runs in a fresh container with no network, a read-only file system, no capabilities, a non-root user, and memory, CPU and process limits, and the worker kills it 10 s after its deadline. Image jobs go to one warm FLUX container on worker A that only the worker can reach, over an internal Docker network.

**Masumi escrow, end to end.** When my agent buys through the escrow route, its payment is locked in Masumi's `vested_pay` V2 contract on preprod, after the job delivers. The lock names worker A as the seller. It commits to the exact request my agent quoted: the request's hash is in the seller-signed terms and in the lock's inline datum. Four deadlines are set: pay by, submit result, unlock and dispute. The same x402 client and facilitator handle it, and nothing about the job flow changes. Then the market acts as the seller with Seller A's key, which it already holds to sign the terms:
- It submits the delivered result's sha256 into the escrow (Masumi's `SubmitResult`). The datum then reads `ResultSubmitted`.
- After the unlock time, a scheduler releases the escrow (Masumi's `Withdraw`): the tUSDM goes to worker A and the buyer's collateral comes back, in one transaction.

When no result comes by the submit-result deadline, my agent, the buyer, takes the lock back (Masumi's `WithdrawRefund`), and the market records the refund only after it finds it on chain: the 16:34 lock of 6 October went back to the buyer that way (`ba8e3eb4…`). I set the deadlines as close as the library allows: the unlock comes about 31 minutes after the 402. Every transaction is evaluated against the real validator before it is signed. For example, the run of 22:49 SGT on 6 October was locked (`2449cbfe…`), had its result submitted (`a137eb54…`), and was released (`055488e5…`) 2.5 minutes after its unlock, with no human step. A dispute is next.

**Agents with a budget.** Claude shops through an MCP server with the same x402 buyer as my agent. Quotes are free. The buy tool enforces the budget I gave: above it, the tool refuses until Claude has asked me, so the ask happens even if the model skips its instructions. My "yes" is recorded as my agent's statement, not as proof, and the wallet's spend caps stay the hard limit. In my recorded run, Claude found nothing within the 3 cents I gave, asked me, and bought worker A's $0.05 image through escrow. The market released it to worker A 33 minutes after the 402 (`35490803…`).

**Open join on probation.** Any Linux machine with Docker installs the worker with one command and joins on probation. The market lists it under an id it chooses, never the name it sent, and strips what it reports to safe characters. It measures the machine with a calibration job whose answer it checks, but never sells it: the quote route and the matcher both skip a worker that does not sell. A worker sells once I add it to the allowlist. The market also checks every image itself (a PNG of the requested size), and a failed check fails the job, so nothing is charged.

## Deploy and scale

Today, one market host runs Caddy, the market, the facilitator and the hosted agent. Three workers run on DigitalOcean: a GPU droplet (RTX 4000 Ada) and two CPU droplets. Workers dial out to the market over WebSocket, so a machine behind NAT can join without opening a port.

To scale:

- **Workers** scale out on their own. A new machine needs Docker and a payout address: one command installs it, and it joins on probation. To sell, it needs a token on the allowlist. Next: recomputation checks, so a market can trust a new worker without a person deciding.
- **The market** keeps offers and jobs in memory. Next: a database for offers, jobs and events, and several market instances that share worker connections through a message bus.
- **The facilitator** holds only a settlement cache, so several can run side by side.
- **Payments.** On mainnet, every token payment carries about 1.2 ADA of minimum ADA. That makes sub-cent jobs uneconomic one by one, so small jobs move to prepaid deposits with batched settlement.

## Next steps

- Prepaid deposits with batched settlement for small jobs. No credit for anonymous agents.
- Masumi dispute: today the seller collects after the unlock time; next, the buyer can open a dispute before it.
- Selling without an allowlist, with recomputation checks: random calibration views, and sampled pixels of real jobs recomputed by the market.
- Distributed jobs: one large render split across several workers.
- Worker-signed escrow terms: today the market holds Seller A's key to sign the terms. Next, the worker signs them itself over its WebSocket.
