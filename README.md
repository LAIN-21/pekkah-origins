# Pekkah

Pekkah is a market where idle machines sell compute per job to AI agents. My agent asks for a job with a deadline and a budget, the market matches it to a worker it has measured, and the agent pays per job with x402 on Cardano preprod, in test tUSDM, with no account. The payment settles only after the job delivers, so a failed job costs nothing.

**Live:** https://146-190-188-100.sslip.io (Cardano preprod, test tokens only)

I built it solo during the TOKEN2049 Origins Hackathon (6 to 7 October 2026). The write-up is in [docs/WRITEUP.md](docs/WRITEUP.md).

## What you can watch

Three real workers are online, each with a measured speed and its own prices:

| Worker | Machine | Sells |
| --- | --- | --- |
| A | RTX 4000 Ada, 20 GB VRAM | images (GPU) and CPU renders |
| B | 8 vCPU | CPU renders |
| C | 2 vCPU | CPU renders |

The run button starts my agent on one of these scenarios:

- **gpu-image**: an image on a GPU with at least 16 GB, at most $0.05, within 60 s. Only A fits.
- **cpu-counter**: an HD render for at most $0.015. Nothing fits, so the market answers with the market price ($0.03) and the next best offer (C at $0.02). My agent's private ceiling allows it, so it accepts.
- **cpu-tight**: a heavy render within 20 s, at most $0.03. A is over budget, C is too slow by its measured speed, so B wins.
- **failover**: my agent buys C and I kill the job mid-run. Nothing is charged, and the agent re-quotes without C and pays B.
- **gpu-image-escrow**: the payment is locked in Masumi's escrow on preprod after the job delivers, with worker A as the seller.

## Architecture

```mermaid
flowchart LR
  agent["Your agent<br/>any x402 client"]
  web["Browser UI"]
  subgraph host["Market host"]
    caddy["Caddy<br/>HTTPS"]
    market["Market<br/>matcher, offers, jobs, events"]
    facilitator["x402 facilitator"]
    hosted["Hosted agent<br/>run button"]
  end
  subgraph workers["Workers, dialing out"]
    A["Worker A<br/>RTX 4000 Ada"]
    B["Worker B<br/>8 vCPU"]
    C["Worker C<br/>2 vCPU"]
  end
  blockfrost["Blockfrost"]
  chain[("Cardano preprod<br/>tUSDM, Masumi escrow")]

  agent -- "quote, 402, signed payment" --> caddy
  web -- "/api and /ws/ui" --> caddy
  caddy --> market
  hosted --> market
  market -- "verify, settle" --> facilitator
  facilitator --> blockfrost --> chain
  A -- "wss /ws/worker" --> caddy
  B -- "wss /ws/worker" --> caddy
  C -- "wss /ws/worker" --> caddy
```

- `apps/market`: quotes, offers, the paid routes, the worker registry, the event log and the UI's WebSocket.
- `apps/facilitator`: the x402 facilitator for `cardano:preprod`. It verifies signed payments and broadcasts them through Blockfrost.
- `apps/agent`: my agent. It runs as a CLI or as the hosted service behind the run button.
- `apps/worker`: runs on each machine. It measures the hardware, dials out to the market and runs jobs in sandboxed containers.
- `packages/matcher`: the pure matching function. `packages/protocol`: every schema, shared by all apps.
- `workloads/fractal`: a deterministic CPU render in integer arithmetic, so the same job gives the same bytes on every CPU. `workloads/flux`: the GPU image server on worker A.

Workers need no inbound port: they dial out to the market. Each CPU job runs in a fresh container with no network, a read-only file system, no capabilities, a non-root user, and memory, CPU and process limits. Image jobs go to one warm FLUX container on worker A, which only the worker can reach, over an internal Docker network.

## How a payment works

1. **Quote.** My agent sends a compute request: the workload, a deadline and a budget. The market answers with offers from the workers it has measured, or with the market price and a counter-offer when nothing fits, plus a reason for every worker it rejected.
2. **Decide.** The agent accepts an offer within its private ceiling, or declines. No human step.
3. **402.** The agent asks for the job. The market answers `402 Payment Required`: pay this worker's address this price, in tUSDM.
4. **Sign.** The agent checks that the 402 asks for exactly the offer it accepted and that its spend caps allow it. It then signs a Cardano transaction and sends it with the request.
5. **Run.** The facilitator verifies the signed transaction. The market dispatches the job to that worker and waits for the result.
6. **Settle.** Only after the result arrives does the facilitator broadcast the transaction and wait for it on chain. The agent gets the result and a receipt with a Cardanoscan link. If the job fails, the transaction is never broadcast and nothing is charged.

With the escrow route, step 6 locks the payment in Masumi's `vested_pay` escrow contract instead of paying the worker. The lock names worker A as the seller and commits to the exact request my agent quoted. Nothing is released to the worker: I built the lock, and release, refund and dispute are my next step.

## Real runs

Every run is a real transaction on Cardano preprod. `scripts/demo-check.sh` appends each passing run to [docs/RUNS.md](docs/RUNS.md).

<!-- PR-11: copy the passing rows from docs/RUNS.md here (real runs only). -->

## Masumi escrow evidence

<!-- PR-11: copy the Masumi evidence block from docs/RUNS.md here (written by scripts/demo-check.sh --escrow). -->

## Run it locally

You need Node 22, pnpm, Docker, a Blockfrost project id for preprod, and a preprod wallet with test tUSDM and some tADA.

```bash
pnpm install
scripts/init-env.sh
```

`init-env.sh` creates `~/.pekkah/local.env` with every name the apps read. Fill in the values (Blockfrost, the buyer mnemonic, the worker's payout address), then check them. The check prints names only, never values:

```bash
scripts/check-env.sh local
```

Build the job image, then start the facilitator, the market and one worker:

```bash
docker build -t pekkah/fractal:local workloads/fractal
```

```bash
pnpm dev
```

In another terminal, run my agent against the local market. This makes a real preprod payment of a few cents in test tUSDM:

```bash
pnpm agent run cpu-counter --market http://127.0.0.1:8080
```

`pnpm check` runs the linter, the type checks and the tests.

## Run a worker

A worker is one container on any machine with Docker. It needs no inbound port.

1. Copy `deploy/env-examples/worker-b.env.example` to `worker.env` and fill it in:
   - `WORKER_TOKEN`: the market only accepts workers on its allowlist.
   - `MARKET_WS_URL`: for example `wss://<market host>/ws/worker`.
   - `PAYOUT_ADDRESS`: the address that receives this worker's payments.
   - `PRICE_FRACTAL_USD`, `JOB_CPUS` and `JOB_MEMORY`.
2. Build the job image and start the worker:

```bash
docker build -t pekkah/fractal:local workloads/fractal
```

```bash
docker compose -p pekkah-worker -f deploy/worker.compose.yml --env-file worker.env up -d --build
```

The worker reports its hardware, passes a calibration job whose answer the market checks, and then takes jobs.

## Honest limits

- Preprod only, paid in test tokens.
- Workers join by allowlist (one token each) for the demo. Open registration is next.
- CPU work is answer-checked at calibration, not on every job. GPU work is timed, not verified.
- Between verification and settlement, the market holds the buyer's signed transaction. If the job fails, the market discards it, but a dishonest market could still broadcast it before its 10-minute TTL. Escrow is the fix: with Masumi the money sits in a contract bound to the request, not with the market or the worker. Today I can lock into Masumi's escrow; release, refund and dispute tooling is the next step, and until it exists my test locks stay locked.
- The reverse risk also exists: a buyer could spend the same inputs elsewhere before settlement. The worker then loses that job's compute, but the market withholds the result.
- Every token payment carries about 1.2 tADA of minimum ADA, which makes sub-cent payments uneconomic on mainnet today. Next: prepaid deposits with batched settlement. No credit for anonymous agents.
- One market instance with in-memory state. A restart drops open offers; agents re-quote.
- For Masumi, the market holds Seller A's key to sign the escrow terms, so in this demo the market could also spend Seller A's funds. Next: the worker signs the terms itself over its WebSocket.

## Licence

There is no licence file. The `@x402` packages I use are Apache-2.0. `apps/facilitator` is ported from the Cardano Foundation's x402-express starter and keeps its MIT notice.
