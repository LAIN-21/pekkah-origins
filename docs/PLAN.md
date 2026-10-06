# Pekkah build plan

Written Monday 5 October 2026, before kickoff, and revised Tuesday morning (a real Masumi escrow lock became a requirement for the Cardano track; repo and droplet names). This is planning only, with no code. It is the spec for the build; `CLAUDE.md` holds the rules. Where this file differs from the "Pekkah Hackathon Playbook" doc, this file wins (prices, gates, GPU model, scenarios and confirmation policy all changed).

## Contents

0. How to use this plan
1. What I'm building
2. Fixed facts
3. Architecture
4. Payments (verified against @x402 2.26.0)
5. Protocol, APIs and config
6. Matching, estimates and calibration
7. Workloads and the job sandbox
8. Repo layout and ownership
9. PR specs
10. Timeline and gates
11. Cut order and fallbacks
12. Demo check, recording and submission
13. Ops runbook
14. Known risks and honest limits
15. References

---

## 0. How to use this plan

**Priorities, in order.** When anything competes for time, the higher level wins:
1. **Core marketplace**: real workers, quotes, x402 payments settled only on delivery, failover. Both tracks need it. GPU image generation is the one core piece that can be cut (to the CPU-only demo, section 11).
2. **Cardano/Masumi requirement**: the Masumi minimum (4.9), a real escrow lock bound to a real compute request. The Cardano Agentic Commerce submission needs it and it is never cut. Masumi work beyond the minimum is not part of this level.
3. **Presentation**: UI polish, the escrow card and its extras, HTTPS. The video, deck, README and write-up are required deliverables: they have their own slots after the freeze (earlier when the build finishes early) and are never cut, only kept simple.
4. **Bonuses**: B1 MCP, PR-10b, live hours, more escrow scenarios: any Masumi scope beyond the minimum that isn't UI.

- Two Claude Code sessions build in parallel. Session A owns Track A, Session B owns Track B. Section 8 lists who owns which files.
- Each PR in section 9 has an objective, a scope, notes, acceptance checks, a gate and a cut-line. Build only that scope. Run the acceptance checks yourself, send the report format in `CLAUDE.md`, and keep working (CLAUDE.md, workflow step 5) while I review.
- **Gates are deadlines, never start times.** Every PR starts the moment its dependencies are merged (table in section 10), whatever the clock says. Finishing early means the next PR starts early. Nobody ever waits for a clock time. At a missed gate, take the fallback in section 11 instead of pushing on. Times are SGT (UTC+8).
- **Timeboxes are maximums.** PR-02m's 45 minutes (the Masumi feasibility gate) and FLUX's 90 minutes are caps; stop the moment it works.
- **No padding.** Once a PR's acceptance passes, it's done. No extra polish or scope to use up time; leftover time goes to the next PR. Polish has its own place in the cut order (section 11) and comes only after the core and the Masumi minimum.
- If something here proves wrong (an API differs, a number is off), fix it in the PR, say so under RISKS, and correct this file in the same PR.

---

## 1. What I'm building

Pekkah is a market where idle machines sell compute per job to AI agents. A provider runs the Pekkah worker: it measures the machine, announces prices and live hours, and dials out to the market. An agent asks for a job (an image, or a CPU render) with a deadline and a price. The market matches deterministically. If offers fit, the agent picks one. If none fit, the market returns the market price and the next best offer, and the agent accepts or declines. The agent pays per job with x402 on Cardano (tUSDM on preprod), with no account. The payment settles only after the job delivers. There is no seller AI agent: the market is deterministic, and the buyer is "your agent", meaning any x402 client.

Today: per-job x402 payments, settled on delivery. Next: prepaid deposits with batched settlement for small jobs. No credit, ever, for anonymous agents.

### What the judges see

1. Three real workers online: A (RTX 4000 Ada, 20 GB), B (8 vCPU), C (2 vCPU), each with a measured speed ✓ and prices.
2. **gpu-image**: my agent needs an image, GPU with at least 16 GB, at most $0.05, within 60 s. Only A fits. 402 → signed → verified → the GPU works (utilisation rises) → the image appears → settled, with a Cardanoscan link → receipt.
3. **cpu-counter**: my agent offers at most $0.015. No exact match. The market answers: market price $0.03, next best C at $0.02. My agent's private ceiling is $0.03, so it accepts. C runs the job and C is paid.
4. **cpu-tight**: deadline 20 s, at most $0.03. A is over budget; C is too slow by its measured benchmark; B is selected and paid.
5. **failover**: my agent buys C. I kill the job container mid-run. The job fails, nothing is charged (no transaction exists), and the agent re-quotes without C and pays B.
6. **gpu-image-escrow** (PR-10, required for the Cardano track): the same kind of job, but when it delivers, my agent's payment is locked in Masumi's escrow on preprod, with worker A as the seller and the escrow bound to the exact request. Nothing is released to the worker: I implement the lock, not release, refund or dispute.

### Deliverables (on BuilderBase, by Wed 7 Oct 23:59 SGT)

- Public GitHub repo, with a README, an architecture diagram and real preprod tx hashes.
- Project link: the hosted URL with a guarded run button.
- Slides: a Google Drive link to a .key or .ppt with the demo video embedded. No YouTube links, no live demo on stage.
- Demo video, 3:00 or less.
- Write-up: the problem, the technical approach (tools, frameworks, Cardano infrastructure), and how it could be deployed and scaled.
- Submit to the main track first, then add the Cardano Agentic Commerce track. The Cardano submission counts as ready only with the Masumi minimum (4.9) and its evidence (12.3). Without it, the main track submission goes ahead and the Cardano track is not ready.

Judging. Cardano track: technical execution and use of Cardano 30% (Masumi, eUTxO, native tokens, smart contracts, extendable code), innovation 20%, UX and design 20% (understandable to someone new to blockchain), impact and feasibility 20%, pitch 10%. Main track: functionality and execution 30%, technical implementation and integration 25%, innovation 20%, usefulness and impact 15%, demo and presentation 10%.

---

## 2. Fixed facts

| Item | Value |
| --- | --- |
| Hacking window | Tue 6 Oct 12:00 → Wed 7 Oct 23:59 SGT. Top 5 announced Thu 12:00 (I attend). Stage Thu 16:00 (slides and video only) |
| Builder | Luis Infante, solo. GitHub LAIN-21, X @LAIN_2105. All docs in first person singular |
| Repo | `github.com/LAIN-21/pekkah-origins` (public), local `~/Developer/pekkah-origins`. My older private repo `LAIN-21/pekkah` is unrelated: never push to it |
| Cloud | DigitalOcean, region `tor1`, SSH key id `59840566`, $85 prepaid, plan ≤ $65 through Thursday |
| Worker A | Existing GPU droplet named `pekkah` (called gpu-hold in Monday notes), `159.203.0.34`, 500 GB disk, RTX 4000 Ada 20 GB, 8 vCPU, 32 GB RAM, image `gpu-h100x1-base` (Docker and NVIDIA toolkit preinstalled), about $0.76/h. Kept empty until Tue 12:00 |
| New droplets | market `s-2vcpu-4gb` plus a reserved IP; worker B `s-8vcpu-16gb-amd` in `nyc3` (`s-8vcpu-16gb` doesn't exist and no 8 vCPU basic size is offered in tor1; workers dial out, so the region only adds latency); worker C `s-2vcpu-2gb`; image `ubuntu-24-04-x64` |
| Chain | Cardano preprod, x402 network id `cardano:preprod`. Explorer: `https://preprod.cardanoscan.io/transaction/<hash>` |
| Provider | Blockfrost project `pekkah-preprod` (`BLOCKFROST_PROJECT_ID`), base URL `https://cardano-preprod.blockfrost.io/api/v0`, 50k requests a day |
| Asset | tUSDM, 6 decimals: `e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d` (this is `USDM_PREPROD_ASSET` in `@x402/cardano`). Masumi's dispenser hands out a different "tUSDM" (policy `16a55b2a…`); `PEKKAH_ASSET` overrides the default if my buyer holds that one |
| Wallets | Buyer (`BUYER_MNEMONIC`): tADA plus 1,000 tUSDM (policy `e675b46e…`, checked Monday night). Sellers A, B, C: one address each (`PAYOUT_ADDRESS` per worker). `SELLER_A_MNEMONIC` is used only for Masumi: the PR-02m feasibility gate and PR-10, where it signs the escrow terms |
| Packages | `@x402/core`, `@x402/express`, `@x402/fetch`, `@x402/cardano` pinned to exactly `2.26.0`; `@evolution-sdk/evolution` `0.5.14`; `express` `^4.21`; Node 22; pnpm |
| Prices | A: image $0.05, fractal $0.05 · B: fractal $0.03 · C: fractal $0.02 (atomic `50000`, `30000`, `20000`) |
| Agent caps | ≤ $0.10 per payment (`100000` atomic), ≤ $0.20 per run, ≤ $5.00 per day for the hosted agent service |
| Local secrets and state | Outside the repo, in `~/.pekkah/`: `local.env` (local dev), `env/<role>.env` (deployed hosts), `hosts.json`, `terraform.tfstate`. Both sessions' checkouts read the same files, and nothing secret can be committed by accident |
| Confirmations | `l1Confirmations: 0`, meaning block inclusion: about 20 s on average on preprod, with gaps of up to about 80 s |

---

## 3. Architecture

```
  Your agent (the buyer)                 Pekkah Market  (market droplet, tor1)
  apps/agent · apps/mcp                  ┌────────────────────────────────────────────┐
  packages/buyer (x402 client)           │ Caddy :80 / :443                            │
     │  POST /api/quote ───────────────▶ │  market :8080                               │
     │  ◀── offers, market price ─────── │   matcher (pure) · offers · jobs · events   │
     │  POST /api/jobs/:offerId ───────▶ │   x402 middleware ── facilitator :4022 ─────┼─▶ Blockfrost ─▶ Cardano preprod
     │  ◀── 402 (payTo = the worker) ─── │                                             │
     │  POST + PAYMENT-SIGNATURE ──────▶ │   verify → dispatch → result → settle       │
     │  ◀── 200 + result + receipt ───── │   /ws/ui ──▶ browsers                        │
                                         │   /ws/worker ◀── workers dial out (wss)     │
                                         └──────────────▲────────────────▲─────────────┘
                                                        │                │
   Worker A: droplet `pekkah` (RTX 4000 Ada)   Worker B (8 vCPU)   Worker C (2 vCPU)
   worker + warm FLUX server                     worker              worker
          Every job runs in a sandboxed container with no network.
```

| Component | Runs on | Port | Talks to |
| --- | --- | --- | --- |
| Caddy | market droplet | 80, 443 (public) | market |
| `apps/market` | market droplet | 8080 (internal) | facilitator, workers (WS), browsers (WS), agent service |
| `apps/facilitator` | market droplet | 4022 (internal) | Blockfrost |
| `apps/agent` (service mode) | market droplet | 4100 (internal) | market, Blockfrost |
| `apps/web` | served by the market | none | market (`/api`, `/ws/ui`) |
| `apps/worker` | A, B, C | nothing inbound | market (outbound wss), local Docker |
| `workloads/fractal` | job containers on A, B, C | none | nothing (`--network none`) |
| `workloads/flux` | A, one warm container | 8000 on an internal Docker network | nothing outside that network |

Workers dial out to the market, so a worker needs no inbound port besides SSH. Any machine behind NAT can join the same way.

---

## 4. Payments

### 4.1 Library facts I verified tonight

Source: the x402-foundation/x402 repo at the `npm-@x402/*@v2.26.0` tags, the MIT starter `cardano-foundation/developer-portal/examples/templates/x402-express`, and the server of `cardano-foundation/x402-cardano-demo`. After `pnpm install`, re-check anything not listed here in `node_modules/@x402/*/dist` before relying on it.

1. **Price and payTo per request.** In `@x402/core/server`, `PaymentOption.payTo` is `string | DynamicPayTo` and `price` is `Price | DynamicPrice`. Both functions take `(ctx: HTTPRequestContext)` and may be async; `ctx.path` is the request path. Route keys accept Express-style params, for example `"POST /api/jobs/:offerId"`.
2. **No settlement on failure.** `@x402/express` buffers the handler's response until `res.end()`. If the status is 400 or above, the verified payment is cancelled (`onVerifiedPaymentCanceled`, reason `handler_failed`), settle never runs, and the error is sent. If the handler throws, the payment is cancelled (`handler_threw`) and `next(err)` runs. Below 400, it settles: success adds `PAYMENT-RESPONSE` and sends the body; failure sends 402 (or `settlementFailedResponseBody`) and drops the body.
3. **The handler runs after verify and before settle, and again on every paid retry** with the same header. Handlers must be idempotent per transaction.
4. **Hooks** on `x402ResourceServer`: `onBeforeVerify` (may return `{ skip: true, result }`), `onAfterVerify` (may return `{ abort: true, reason }`), `onVerifyFailure`, `onBeforeSettle`, `onAfterSettle`, `onSettleFailure`, `onVerifiedPaymentCanceled`. Each context has `paymentPayload`, `requirements` and, for HTTP, `transportContext = { request: { path, method, adapter }, responseBody?, responseHeaders? }`.
5. **Transaction id before broadcast.** `decodeCardanoTransaction(String(paymentPayload.payload.transaction))` from `@x402/cardano` returns `{ txHash, ttlSlot, inputs, outputs, fee, ... }`. `decodePaymentSignatureHeader(header)` lives in `@x402/core/http`. The txHash is the idempotency key and the UI's correlation id from the moment the agent signs.
6. **Server scheme.** `new ExactCardanoScheme()` from `@x402/cardano/exact/server`, registered with `resourceServer.register("cardano:preprod", scheme)`. Price as `{ amount: "50000", asset: PEKKAH_ASSET }` (preferred: exact and explicit). `"$0.05"` also resolves to preprod USDM.
7. **Route extra.** `{ assetTransferMethod: "default", areFeesSponsored: false, confirmationPolicy: { l1Confirmations: 0 } }` and `maxTimeoutSeconds: 600`. That is the transaction's validity window: the job and the settlement must both fit inside it. Core deletes `assetTransferMethod: "default"` from the 402 it sends (`applyPaymentFlowWireExtra`), so anything reading requirements (the buyer's checks, receipts) treats a missing `assetTransferMethod` as `default`.
8. **Facilitator** = the starter's `src/facilitator.ts`: `x402Facilitator` from `@x402/core/facilitator`; `toFacilitatorCardanoSigner({ network, provider: { blockfrost: { baseUrl, projectId } }, awaitConfirmation: false })` from `@x402/cardano`; `new ExactCardanoScheme(signer, { confirmationTimeoutMs })` from `@x402/cardano/exact/facilitator`. Routes: `POST /verify`, `POST /settle` (it maps "Settlement aborted:" errors to `{ success: false }`), `GET /supported`, `GET /health`. It holds no keys and no funds. It supports the `default`, `masumi` and `script` methods and advertises `l1Confirmations` 0 to 20 with Blockfrost (−1 only with `acceptMempool`). It has an in-memory duplicate-settlement guard keyed by tx id.
9. **Timeouts.** The facilitator waits up to `confirmationTimeoutMs` (75 000) per settle; core retries settle once on `settlement_pending`. The market's client must wait longer: `new HTTPFacilitatorClient({ url, timeoutMs: 120000 })` (at least 15 s more than the facilitator's wait). Worst case for one paid request: a job of up to 120 s plus a settlement of up to about 160 s. The buyer's HTTP client therefore needs 600 s header and body timeouts: `setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }))` from `undici`.
10. **Buyer.** `new x402Client().setSpendControls({ allowedAssets: [{ network: "cardano:preprod", asset: PEKKAH_ASSET, maxAmountPerPayment: "100000" }] })`; `toClientCardanoSigner({ mnemonic, network: "cardano:preprod", provider: { blockfrost: { baseUrl, projectId, requestTimeoutMs: 30000 } } })` from `@x402/cardano`; `client.register("cardano:*", new ExactCardanoScheme(signer))` with the scheme from `@x402/cardano/exact/client`; `wrapFetchWithPayment(fetch, client)` and `x402HTTPClient` from `@x402/fetch`. Receipt: `new x402HTTPClient(client).getPaymentSettleResponse(name => res.headers.get(name))`. Client hooks: `onBeforePaymentCreation({ paymentRequired, selectedRequirements })` (may return `{ abort: true, reason }`), `onAfterPaymentCreation({ paymentPayload, ... })`, `onPaymentCreationFailure`, `onPaymentResponse({ settleResponse?, error? })`. The `accountIndex` option derives more accounts from one mnemonic. The signer signs and never broadcasts. `wrapFetchWithPayment` throws if the request already carries `PAYMENT-SIGNATURE`, so a resumed retry uses plain `fetch` with the saved header.
11. **Express.** Enable `case sensitive routing` and `strict routing` so the payment gate and the route match identical URLs. Register paid routes directly on `app`, with the payment middleware in the route's own chain (`app.post("/api/jobs/:offerId", preCheck, paid, handler)`), never inside `app.use("/api", router)`: the middleware matches its route keys against `req.path`, which is router-relative inside a sub-router, so the key would not match, the middleware would call `next()`, and the job would run unpaid. Defence in depth: the handler itself refuses (402) unless PaymentOperations holds a verified record for the txHash in the request's `PAYMENT-SIGNATURE`, and a test asserts that an unpaid POST gets 402. Express 4 does not catch async errors: every handler wraps its body in try/catch and always ends the response, or the middleware waits forever for `res.end()`.
12. **Masumi** (the PR-02m feasibility gate and PR-10): see 4.8 and 4.9.

Monday's open questions, answered:

| Question | Answer |
| --- | --- |
| Can the route compute `payTo` and price per request? | Yes, with `DynamicPayTo` and `DynamicPrice` (fact 1). No route per worker needed |
| Does the middleware skip settle when the handler errors? | Yes (fact 2) |
| Confirmation policy? | `0`, block inclusion. Honest, and about twice as fast as the default `1` |
| Official start time? | Tue 12:00 SGT (organiser email) |
| Does tUSDM work with only a price change? | Yes: `{ amount, asset: PEKKAH_ASSET }` on the server, an `allowedAssets` cap on the client. Check the token policy tonight |
| How long must things stay up? | Until the Top 5 call, Thu 12:00. If selected, until Thu 17:00 |
| Image model and licence? | FLUX.1-schnell (Apache-2.0, HF gate "auto") in 4-bit on the 20 GB card; SDXL base 1.0 (OpenRAIL++) as fallback |
| Second GPU? | Not needed |

### 4.2 The paid flow

1. Agent → `POST /api/quote` with a `ComputeRequest`. The market answers with a `Quote`: exact offers, or a counter-offer plus the market price, and a reason for each rejected worker. Each offer binds `{ workerId, payTo, priceAtomic, request, estSec }` under an `offerId`.
2. The agent decides (section 6).
3. Agent → `POST /api/jobs/:offerId` with no payment header. A pre-check (offer exists, still open, worker online) runs before x402, then the x402 layer answers 402 with `PAYMENT-REQUIRED`: payTo = that worker's `PAYOUT_ADDRESS`, amount = the offer price, asset = tUSDM.
4. Before signing, the agent checks that the 402's payTo, amount and asset equal the offer it accepted, and that its per-run and per-day caps allow it. Then the x402 client signs and retries with `PAYMENT-SIGNATURE`.
5. Market: `onBeforeVerify` (resumed-retry skip) → facilitator `/verify` → `onAfterVerify` (claims offer ↔ txHash; emits `payment.verified`) → handler: reserve the worker → dispatch → wait for the result (deadline + 15 s) → store it.
6. Success: 200 body → settle → `onBeforeSettle` (`payment.settling`) → facilitator `/settle` (broadcast, wait for inclusion) → `onAfterSettle` (job marked paid; `payment.settled`, `receipt.issued`) → the response leaves with `PAYMENT-RESPONSE`.
7. Failure: the handler answers 502 → no settle → `onVerifiedPaymentCanceled` (`payment.canceled`: "nothing was charged") → the agent re-quotes without the failed worker.
8. After a settled payment, the agent waits until Blockfrost shows the tx before its next payment.

### 4.3 Hooks and events

| Hook or step | Market action | Event |
| --- | --- | --- |
| 402 served | Mark the offer "402 served" | `payment.required` |
| `onBeforeVerify` | Known txHash with an identical payload: return the cached result (resume) | none |
| `onAfterVerify` (valid) | Claim offer ↔ txHash (idempotent for the same tx); abort `offer_already_purchased` if another tx holds it | none |
| Handler entry | Every verify hook has passed, so the payment is truly verified | `payment.verified` (first time per txHash) |
| Handler | Reserve, dispatch, await, store; return 200 or 502 | `job.dispatched`, `job.running`, `job.progress`, `job.completed` or `job.failed` |
| `onBeforeSettle` | If this txHash already settled (a replayed request), return `{ skip: true, result: storedSettleResponse }` | `payment.settling` (first time only) |
| `onAfterSettle` | `job.paid = true`; the result URL becomes readable | `payment.settled`, `receipt.issued` (first time per txHash) |
| `onSettleFailure` | Keep the result; watch the tx (4.4) | `payment.failed` |
| `onVerifiedPaymentCanceled` | Only for reasons `handler_failed` and `handler_threw`, and only for the txHash that holds the offer: release the worker and close the offer. Ignore `after_verify_aborted` | `payment.canceled` |

How core runs these hooks (checked in the 2.26.0 source), and why the table looks the way it does:
- Hooks registered on the resource server run before the scheme's own hooks (for Masumi, the scheme's `onAfterVerify` binds the quote). So any `onAfterVerify` hook, mine or the scheme's, can still abort after mine ran. That's why `payment.verified` is emitted at handler entry, not in the hook.
- An abort in any `onAfterVerify` hook fires `onVerifiedPaymentCanceled` with reason `after_verify_aborted`. A racing second payment for a claimed offer causes exactly that, and it must not release the worker that the first, valid payment is using.
- An `onBeforeVerify` skip still runs every `onAfterVerify` hook (the claim and the Masumi binding are re-checked, which is why the claim is idempotent). An `onBeforeSettle` skip still runs every `onAfterSettle` hook. That's why events are emitted once per txHash.

Correlate in hooks by computing txHash from `ctx.paymentPayload` (fact 5), and the offer from `ctx.transportContext.request.path`.

### 4.4 Idempotency, retries and late settlement

- **PaymentOperations** (my own code; the CF demo's `paymentOperations.ts` pattern is the reference, but that repo has no licence, so don't copy it): txHash → `{ offerId, payload fingerprint, cached verification, job, response body }`.
- `onAfterVerify` binds the txHash to the offer. A different tx for the same offer is refused.
- `onBeforeVerify` returns `{ skip: true, result: cached }` for a known txHash whose payload fingerprint matches, so a resumed request reaches settle, which resumes waiting instead of rebroadcasting.
- The handler never dispatches twice for one txHash: it awaits or returns the existing job.
- The pre-check admits a request whose txHash already holds the offer (a resumed or replayed request); it rejects only a different payment for a claimed offer (409).
- Offers are single use and expire 120 s after the quote. Once its 402 has been served, an offer stays payable for its `maxTimeoutSeconds`.
- **Late settlement** (PR-09): if settle ends in `settlement_pending` twice, the agent receives 402 even though the tx may still land. The market keeps the result and calls the facilitator's `/settle` again with the stored payload and requirements every 20 s until the TTL. That resumes watching and never rebroadcasts; the facilitator answers a terminal failure once the validity window has closed. On success the market marks the job paid and emits `payment.settled` with `late: true`. On 402 after signing, the agent polls `GET /api/jobs/by-tx/:txHash` until it is paid or the TTL passes. The market itself never calls Blockfrost.

### 4.5 One payment at a time

- One payment in flight per buyer wallet (a mutex in `packages/buyer`). After a settlement, poll Blockfrost `GET /txs/{hash}` every 5 s, for up to 60 s, until it answers 200.
- Never run the CLI agent while the hosted agent service is running a scenario: they share a wallet. If that becomes necessary, give the CLI `BUYER_ACCOUNT_INDEX=1` and fund that account first.

### 4.6 Facilitator app (`apps/facilitator`)

A port of the MIT starter's `src/facilitator.ts`, credited in a header comment. Changes: config through zod-validated env; `GET /health` returns `{ ok, network, confirmationTimeoutMs }`; `GET /tx/:hash` returns `{ found, block?, confirmations? }` from Blockfrost (proof that a cancelled payment never landed; deployed, it's reached through the market's `GET /api/tx/:hash`, since the facilitator is never published); it binds `127.0.0.1` locally and `0.0.0.0` only inside the compose network, never published.

### 4.7 Buyer package (`packages/buyer`)

`createBuyer(config)` returns `{ address, quote(request), decide(quote, policy), buy(offer), balance(), waitForTx(txHash) }`. It emits events through a callback. It enforces the per-payment cap through spend controls, and the per-run and per-day caps in `onBeforePaymentCreation`. In the same hook it refuses to sign unless the 402 matches what the buyer expects (`buy()` passes the expected values: the accepted offer, or, for smoke tests, the seller address and price):
- amount and asset, always;
- default payments (`assetTransferMethod` missing or `"default"`): payTo equals the expected worker address;
- `masumi` payments: payTo equals `masumiEscrowAddress("cardano:preprod")` and `selectedRequirements.extra.terms.sellerAddress` equals the expected worker address. When buying an offer, the part named `parameters` in `extra.inputCommitment.parts` must also have `content` that JCS-equals the request the agent quoted. The signer checks only that the commitment's digests are consistent, not that they describe my request. The PR-02m smoke route commits to its URL instead, so that check doesn't apply there.

The agent CLI, the agent service and the MCP server all use this package.

### 4.8 Masumi escrow (PR-02m feasibility gate, then PR-10)

Masumi is built in two steps. PR-02m, the feasibility gate, makes one real lock from a smoke route on Tuesday. PR-10 builds the Masumi minimum (4.9) on real jobs. Everything below was checked in the 2.26.0 source.

- **Seller signer.** `toMasumiSellerSigner({ mnemonic: SELLER_A_MNEMONIC, network: "cardano:preprod" })` from `@x402/cardano` returns `{ sellerAddress, signTerms }`. At startup, the market checks that `sellerAddress` equals `SELLER_A_ADDRESS` and refuses to enable Masumi otherwise.
- **One scheme instance serves both methods.** `packages/payments`' `createResourceServer` takes an optional `masumi` option. When it's present it registers `new ExactCardanoScheme({ masumi: { seller, commitment } })` instead of the plain scheme. `default` payments behave exactly as before; the Masumi quote store is only used by Masumi routes. Without `SELLER_A_MNEMONIC`, the market starts without Masumi routes.
- **Commitment** (what the escrow is bound to). The PR-02m gate uses the library default, which commits to the resource URL. PR-10 passes one `commitment` callback for the whole scheme (it serves every Masumi route), so it branches on `ctx.transportContext.request.path`. For `/api/escrow-jobs/:offerId` it returns `[{ name: "parameters", canonicalization: "jcs", content: offer.request }]`. For any other route (the smoke route) it returns `[{ name: "resource", canonicalization: "jcs", mediaType: "application/json", content: { url: ctx.resourceInfo.url } }]`, because the library's default isn't exported. The callback gets `{ requirement, resourceInfo, transportContext }`. Content is echoed in the 402 by default (`echoContent: true`), which the buyer's signer requires: it recomputes every part before signing.
- **Route template.** `payTo: masumiEscrowAddress("cardano:preprod")` (static), price `{ amount, asset: PEKKAH_ASSET }` (static in PR-02m, dynamic from the offer in PR-10), `maxTimeoutSeconds: 600`, `extra: { assetTransferMethod: "masumi", confirmationPolicy: { l1Confirmations: 0 } }`. Only template keys may appear in `extra` (`assetTransferMethod`, `confirmationPolicy`, `areFeesSponsored`, `deployment`), and the route offers a single network. The library checks the template only when a request arrives (a bad one turns every call into a 500), so the market also calls the exported `assertMasumiTemplate` at startup and refuses to boot with a bad template.
- **Quotes.** The scheme signs a fresh seller quote (`termsDigest`) for every unpaid 402, so the route is rate-limited. The paid retry is matched against the stored quote. Quotes and offers live in memory, so a market restart between the 402 and the payment makes that payment fail (404 at the pre-check, or no matching requirements). Nothing is charged; the agent re-quotes on 404 or 409.
- **Buyer side needs nothing extra.** The same x402 client pays: `toClientCardanoSigner` detects `assetTransferMethod: "masumi"`, verifies the seller's signature and the commitment, builds the lock with its inline datum, and adds the collateral. The only Pekkah-side check is the 402-matches-offer rule in 4.7.
- **Facilitator needs nothing extra.** It already supports `masumi` and verifies the 19-field lock datum. Unregistered seller (no `agentIdentifier`), so no registry validator.
- **What lands on chain.** The tUSDM price plus tADA collateral (at least about 1.44 tADA, sized from the datum; the client caps it at 15 tADA) locked at the escrow address in Masumi's real `vested_pay` V2 contract, with an inline datum naming the buyer, Seller A, the request hash and four deadlines. Defaults after pay-by (= now + 600 s): submit result +15 min, unlock +35 min, dispute +55 min. The terms are in `extra.terms` (`sellerAddress`, `inputHash`, `payByTime`, `submitResultTime`, `unlockTime`, `externalDisputeUnlockTime`).
- **Lock only.** `@x402/cardano` has no submit-result, release or refund tooling, and a lock it makes cannot be driven through `masumi-payment-service`. With my tooling the locked test funds stay locked, so keep Masumi test runs to a handful. The CF demo's `masumi/` agent shows submit-result and collect (no licence: reference only). UI label: "Locked in Masumi escrow. Release, refund and dispute tooling is my next step."
- **Who the seller is.** The buyer (my agent) locks the funds; the seller named in the escrow is Seller A (worker A's `PAYOUT_ADDRESS`), and the buyer differs from the seller. Escrow purchases are allowed only for offers whose worker address equals the Masumi seller address, which in practice means worker A; otherwise 409. Nothing reaches the seller: that needs release tooling I don't have.
- **Wording.** In every Masumi context (UI, receipts, logs, README, write-up, video, deck), the funds are "locked in escrow". Never say the worker was paid or the funds were released.

### 4.9 The Masumi minimum (required for the Cardano track, never cut)

The Cardano Agentic Commerce submission is ready only when all of these are true for at least one real run on preprod:

1. **Autonomous agent.** My agent (CLI or hosted service) quotes, decides and pays on its own, with no human step.
2. **Real successful compute.** A worker runs the job and the result is delivered. The lock is broadcast only after delivery (settle runs after the handler), so a failed job locks nothing.
3. **Real escrow lock.** The buyer's tUSDM (plus collateral) is locked at Masumi's `vested_pay` V2 escrow address on Cardano preprod by a confirmed transaction.
4. **The selected worker is the seller.** The worker the matcher selected for this job is the seller in the signed terms and the datum. In this demo that is worker A, the only worker configured as a Masumi seller.
5. **Bound to the compute request.** The escrow's input hash (`terms.inputHash`) is the commitment to the exact request the agent quoted (`parameters` = `offer.request`, 4.8). The PR-02m smoke lock commits to a URL, so it doesn't count.
6. **Visible.** The tx hash, escrow address, seller, input hash, amount and asset, and the four deadlines are shown in the agent's receipt and in the evidence block (12.3), with a Cardanoscan link where the inline datum is checked.

The run uses `gpu-image-escrow`. If image generation isn't available (FLUX and SDXL both failed, or the GPU is lost), it uses `fractal-escrow` on worker A instead (6.4); the escrow route doesn't depend on the workload.

Not part of the minimum, so cuttable when behind: the UI escrow card's extras (presentation; the receipt and evidence block remain), and PR-10b and more escrow scenarios (bonuses).

If the minimum isn't reached by 17:00, it alone continues until 18:00 at the latest; if it's still not reached then, the main track submission goes ahead unchanged and the Cardano-track submission is not ready (PR-10's cut rule, section 11).

---

## 5. Protocol, APIs and config

`packages/protocol` holds every schema below as zod, with the TypeScript types inferred from them. Money is atomic (a string of digits, 6 decimals) everywhere except display fields named `*Usd`.

### 5.1 Types

```
WorkloadName    = "fractal" | "image"
FractalParams   = { preset: "tiny" | "calib" | "hd-fast" | "hd-heavy", challenge?: 0..7 (calib only),
                    palette: "ember" | "ocean" | "mint", format: "png" | "raw" }
ImageParams     = { prompt: string (1..300 chars), seed: int, size: 768 | 1024, steps: 1..4 }
ComputeRequest  = { workload, params, constraints: { gpu?: boolean, minVramGb?: number,
                    deadlineSec: 5..120, exclude?: WorkerId[] }, budget: { maxUsd: number } }
                    // 120 s max: the job plus up to ~160 s of settling must fit the 600 s TTL.
                    // The agent's ceiling is private and never sent.
WorkerHardware  = { cpuModel, vcpus, memGb, gpu?: { name, vramGb, driver } }
WorkerPrice     = { workload, usd, atomic }
Calibration     = { fractal?: { overheadSec, calibSec, secPerIter, verified: boolean, challenge, at },
                    image?: { secImage1024x4, verified: false, at } }
WorkerSnapshot  = { workerId, name, payTo, hardware, prices: WorkerPrice[],
                    status: "calibrating" | "online" | "busy" | "offline" | "untrusted",
                    calibration, warm: string[], util?: { cpuPct, gpuPct?, vramUsedGb? },
                    schedule?: string, lastSeenAt, currentJobId? }
Offer           = { offerId, quoteId, workerId, workload, priceUsd, priceAtomic, asset, payTo,
                    estSec, expiresAt, kind: "exact" | "counter" }
Rejection       = { workerId, reason: "offline" | "untrusted" | "not_calibrated" | "busy" |
                    "outside_hours" | "no_workload" | "excluded" | "no_gpu" | "vram_too_small" |
                    "too_slow" | "over_budget", detail: string }
Quote           = { quoteId, runId?, request, offers: Offer[], counterOffer?: Offer & { reason },
                    marketPriceUsd: number | null, rejected: Rejection[], expiresAt }
Job             = { jobId, offerId, runId?, workerId, txHash, status: "dispatched" | "running" |
                    "delivered" | "failed", startedAt, endedAt?, durationMs?, sha256?, mime?,
                    paid: boolean, error? }
JobResultBody   = { jobId, workerId, workload, durationMs, sha256, mime, resultUrl, txHash }
PaymentReceipt  = { txHash, network, payTo, amountAtomic, asset, transferMethod: "default" | "masumi",
                    confirmations?, feeLovelace?, lovelaceInPaymentOutput?, explorerUrl, settledAt }
JobEvent        = { id (ulid), ts (ISO), runId?, jobId?, source: "agent" | "market" | "worker" | "chain",
                    type, data, dev?: true }   // dev: from /api/dev/* test jobs; never shown as runs
```

`feeLovelace` and `lovelaceInPaymentOutput` come from the decoded signed transaction (`fee`, `outputs`). They let the receipt state honestly that about 1.2 tADA of minimum ADA travels with every token payment.

### 5.2 Events

| Source | Types |
| --- | --- |
| agent | `run.started` {scenario, request} · `agent.decision` {kind: exact, counter or declined, chosen?, reasons[]} · `payment.signed` {txHash, payTo, amountAtomic} · `agent.reroute` {excluded[], reason} · `agent.balance` {lovelace, assetAtomic} · `run.completed` {jobId, workerId, txHash, totalMs} · `run.failed` {reason} |
| market | `quote.issued` · `payment.required` · `payment.verified` · `job.dispatched` · `job.running` · `job.progress` {pct} · `job.completed` {durationMs, sha256} · `job.failed` {reason} · `payment.settling` · `payment.settled` {txHash, confirmations, explorerUrl, late?} · `payment.canceled` {reason} · `payment.failed` {reason} · `receipt.issued` {receipt, resultUrl} · `worker.online` · `worker.offline` · `worker.calibrated` {verified, sec} · `escrow.locked` (PR-10) {txHash, escrowAddress, sellerAddress, amountAtomic, asset, collateralLovelace, inputHash, payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime, explorerUrl} |

For `transferMethod: "masumi"`, `payment.settled` means the lock transaction is on chain; every user-facing text for it says "locked in escrow", never "paid" or "released" (4.8).

Every event carries the `runId` when one exists. The agent sends `X-Pekkah-Run-Id` on its quote and job requests; the market tags everything that follows with it.

### 5.3 Worker WebSocket (`/ws/worker`)

JSON messages, a zod discriminated union on `type`. Max payload 32 MB.

- Worker → market: `hello` {workerId, token, version, name, payTo, hardware, prices: [{workload, usd}], schedule?, warm[]} · `heartbeat` {busy, currentJobId?, util, warm[]} every 5 s, every 2 s while busy (a workload counts as offered only while it is in `warm`, so A advertises `image` the moment flux reports ready) · `job.accepted` {jobId} · `job.progress` {jobId, pct, note?} · `job.result` {jobId, ok: true, mime, sha256, bytes, dataBase64, durationMs} or {jobId, ok: false, error, durationMs}
- Market → worker: `welcome` {workerId, serverTime} · `job.dispatch` {jobId, kind: paid, calibration or dev, workload, params, deadlineSec} · `job.cancel` {jobId, reason} · `error` {code, message}, then close.
- Auth: the token in `hello` must match `WORKER_TOKENS[workerId]`. Silent for 15 s → offline. Reconnect with backoff (1 s, doubling, max 5 s).

### 5.4 HTTP API (market)

| Route | Notes |
| --- | --- |
| `GET /api/health` | `{ ok, version, workersOnline }` |
| `GET /api/workers` | `WorkerSnapshot[]` |
| `POST /api/quote` | Body `ComputeRequest`; returns `Quote`. Rate limit 30/min per IP |
| `POST /api/jobs/:offerId` | x402-paid. 200 `JobResultBody` plus `PAYMENT-RESPONSE`. Rate limit 10/min per IP |
| `GET /api/jobs/:jobId`, `GET /api/jobs/by-tx/:txHash` | Job status |
| `GET /api/tx/:hash` | Forwards to the facilitator's `GET /tx/:hash` (on-chain status from Blockfrost). Rate limit 30/min per IP |
| `GET /api/results/:jobId` | The PNG, only once `paid` |
| `GET /api/runs/latest`, `GET /api/runs/:runId/events` | Replay and demo-check |
| `POST /api/agent-events` | Bearer `AGENT_TOKEN`; agent events into the bus |
| `POST /api/demo/run` | `{ scenario }`, public scenarios only: gpu-image, cpu-counter, cpu-tight (failover needs a real kill, so it runs only from demo-check or the CLI). Guards: one run at a time, `DEMO_COOLDOWN_SEC` between runs, `DEMO_DAILY_RUNS` cap, 2/min per IP. Bearer `DEMO_TOKEN` skips the cooldown and the daily cap and allows every scenario. The market creates the `runId` and forwards to the agent service |
| `WS /ws/ui` | Read-only: a `snapshot` {workers, recentEvents, demo: {running, cooldownUntil, runsLeftToday}}, then `event`, `workers` (at most once a second) and `demo` messages |
| `/api/dev/*` | Test routes, all enabled only when `PEKKAH_DEV_ROUTES=1` **and** the request carries `Bearer DEMO_TOKEN`: `POST /api/dev/smoke/:seller` (PR-02) and `POST /api/dev/smoke-escrow` (PR-02m), real x402 smoke payments; `POST /api/dev/dispatch` (unpaid test jobs for PR-04 to PR-07b). Their events carry `dev: true`, and the UI never shows them as runs. PR-11 turns them off in production |
| Static | The market serves `apps/web/dist` at `/` with an SPA fallback, when the folder exists |
| `POST /api/escrow-jobs/:offerId` | PR-10. Only for offers whose worker is the Masumi seller (worker A); otherwise 409 |

### 5.5 Config (env names; values never in Git)

| Service | Variables |
| --- | --- |
| facilitator | `BLOCKFROST_PROJECT_ID`, `BLOCKFROST_BASE_URL`, `FACILITATOR_HOST`, `FACILITATOR_PORT=4022`, `CONFIRMATION_TIMEOUT_MS=75000`, `ACCEPT_MEMPOOL=false` |
| market | `MARKET_PORT=8080`, `PUBLIC_URL`, `FACILITATOR_URL`, `FACILITATOR_TIMEOUT_MS=120000`, `PEKKAH_ASSET`, `L1_CONFIRMATIONS=0`, `WORKER_TOKENS` (`A:…,B:…,C:…`), `AGENT_TOKEN`, `DEMO_TOKEN`, `AGENT_URL`, `DEMO_COOLDOWN_SEC=120`, `DEMO_DAILY_RUNS=40`, `DATA_DIR=/var/lib/pekkah`, `PEKKAH_DEV_ROUTES` (`=1` locally and on the deployed market until PR-11; then I remove it from `~/.pekkah/env/market.env` and Claude redeploys), `SELLER_A_ADDRESS` / `SELLER_B_ADDRESS` / `SELLER_C_ADDRESS` (PR-02 smoke; A is also the Masumi seller check), `SELLER_A_MNEMONIC` (optional: enables Masumi, for PR-02m and PR-10) |
| agent | `MARKET_URL`, `AGENT_TOKEN`, `BUYER_MNEMONIC`, `BUYER_ACCOUNT_INDEX=0`, `BLOCKFROST_PROJECT_ID`, `BLOCKFROST_BASE_URL`, `PEKKAH_ASSET`, `CAP_PER_PAYMENT_USD=0.10`, `CAP_RUN_USD=0.20`, `CAP_DAY_USD=5`, `AGENT_MODE=cli` or `service`, `AGENT_PORT=4100` |
| worker | `WORKER_ID`, `WORKER_NAME`, `WORKER_TOKEN`, `MARKET_WS_URL`, `PAYOUT_ADDRESS`, `PRICE_FRACTAL_USD`, `PRICE_IMAGE_USD` (A only), `SCHEDULE` (optional, e.g. `09:00-23:00 Asia/Singapore`), `JOB_CPUS`, `JOB_MEMORY`, `FRACTAL_IMAGE=pekkah/fractal:local`, `FLUX_URL=http://flux:8000` (A only), `DATA_DIR=/var/lib/pekkah` |
| flux (A) | `FLUX_MODEL=flux` or `sdxl`, `HF_HUB_OFFLINE=1`, `MODELS_DIR=/models`; `HF_TOKEN` for the one-off `flux-fetch` only |
| mcp | `MARKET_URL`, `BUYER_MNEMONIC`, `BUYER_ACCOUNT_INDEX=0`, `BLOCKFROST_PROJECT_ID`, `BLOCKFROST_BASE_URL`, `PEKKAH_ASSET`, `CAP_PER_PAYMENT_USD=0.10` |
| my Mac only | `DIGITALOCEAN_TOKEN`, set Monday in the desktop app's Local environment (gear icon), so every Claude session's shell has it for Terraform and doctl. Never written to any file |
| caddy | `PUBLIC_HOST`: a hostname such as `<ip-with-dashes>.sslip.io` (automatic HTTPS), or `http://<ip>` for plain HTTP. A bare IP without `http://` makes Caddy serve HTTPS with its own untrusted certificate |

- Secrets and state live outside the repo, in `~/.pekkah/` (`PEKKAH_HOME`). Local dev loads `~/.pekkah/local.env` (path overridable with `PEKKAH_ENV_FILE`). Deployed hosts get `~/.pekkah/env/<role>.env`, copied to the host with mode 600 and passed to compose with `--env-file`. Compose passes each container only the variables it needs, through `environment:` with `${VAR}` interpolation, never a blanket `env_file:`. The market container never sees `BUYER_MNEMONIC`.
- Values containing spaces (mnemonics) are written in double quotes: `BUYER_MNEMONIC="word1 word2 …"`.
- `deploy/env-examples/*.env.example` (in Git) list the names. `scripts/init-env.sh` creates the missing files in `~/.pekkah` and appends only the names a file lacks (it never overwrites a value, including the `local.env` I write by hand at 12:00), generates the random tokens, and leaves `__FILL_ME__` for the real secrets, which I fill in. `scripts/check-env.sh` parses the files line by line (never `source`: bash would execute the words of an unquoted mnemonic) and prints each name with `set` or `MISSING`, never a value.
- Every app validates its env with zod at startup and exits listing the missing names.

---

## 6. Matching, estimates and calibration

### 6.1 Matcher (`packages/matcher`, a pure function)

`match(request, workers, now) → { offers, counterOffer?, marketPriceUsd, rejected }`

1. Eligibility. For each worker, the first failing check names its rejection, in this order: `excluded` → `no_gpu` → `vram_too_small` → `no_workload` → `offline` → `untrusted` → `not_calibrated` (for this workload) → `busy` → `outside_hours` → `too_slow` (estSec > deadlineSec). Hardware reasons come first so the story reads right ("B: no GPU", not "B: not calibrated").
2. Exact offers: eligible workers with price ≤ `budget.maxUsd`, sorted by price, then estSec, then workerId. Eligible workers above `maxUsd` go into `rejected` as `over_budget` ("$0.05 > $0.03").
3. `marketPriceUsd` = the median price of all eligible workers (the lower middle for an even count; `null` if none are eligible).
4. If there are no exact offers, `counterOffer` = the cheapest eligible worker, with a reason ("No offer at or below $0.015. Market price $0.03. Next best: C at $0.02, about 31 s").
5. Offers get an `offerId` and expire 120 s later.

The agent accepts the exact offer at the top. Otherwise it accepts the counter-offer if its price ≤ the agent's private ceiling and its estSec ≤ the deadline. Otherwise it declines. Every decision emits `agent.decision` with plain-language reasons.

### 6.2 Estimates

The fixed cost of a job (container start, imports, transfer: 1 to 2 s) must not be scaled with the work, or the estimates for big jobs come out far too close together to tell B from C.

- fractal: `estSec = overheadSec + secPerIter × presetIters × 1.15`, where:
  - `overheadSec` = the measured dispatch-to-result time of the `tiny` preset (8×8, maxIter 1);
  - `secPerIter = max(calibSec − overheadSec, 0.05) / calibIters[challenge]`;
  - `calibIters[]` and `presetIters` are the exact total iteration counts of each calibration view and preset, computed once by `pnpm calib:ref` and committed in `packages/protocol`. The views differ in work, so a pixel count is not enough.
- image: `estSec = 1.0 + secImage1024x4 × (steps / 4) × (size / 1024)² × 1.2`, where `secImage1024x4` is a measured real generation at 1024², 4 steps.

### 6.3 Presets (starting values; PR-05 tunes them on real hardware)

| Preset | Size | Supersampling | maxIter | Used by |
| --- | --- | --- | --- | --- |
| `tiny` | 8×8 | 1 | 1 | Measures fixed overhead |
| `calib` | 640×360 | 1 | 1500 | Calibration (8 challenge views) |
| `hd-fast` | 1280×720 | 2 | 600 | cpu-counter |
| `hd-heavy` | 1920×1080 | 2 | 1500 | cpu-tight, failover |

Tuning rule for `hd-heavy`, from measured numbers: est(B) ≤ 12 s and est(A) ≤ 16 s (deadline 20 s, so A shows `over_budget`, not `too_slow`); est(C) ≥ 30 s (C is `too_slow`); est(C) ≤ 96 s (C stays eligible for failover's 120 s deadline). If no preset satisfies all four, change the preset's size or iterations, not the story.

### 6.4 Scenarios

Requests live in `packages/protocol/src/scenarios.ts`. The agent's private ceilings live only in `apps/agent` (the protocol package ships in the web bundle).

| Scenario | Request | Agent's private ceiling | Expected |
| --- | --- | --- | --- |
| `gpu-image` | image {fixed prompt, seed 7, 1024, 4 steps}, gpu, minVram 16, deadline 60 s, maxUsd 0.05 | 0.05 | A, exact, $0.05 |
| `cpu-counter` | fractal hd-fast, deadline 120 s, maxUsd 0.015 | 0.03 | no exact; market $0.03; counter C $0.02 accepted |
| `cpu-tight` | fractal hd-heavy, deadline 20 s, maxUsd 0.03 | 0.03 | B exact; A over budget; C too slow |
| `failover` | fractal hd-heavy, deadline 120 s, maxUsd 0.02 | 0.04 | C exact → killed → no charge → re-quote excluding C → counter B $0.03 accepted |
| `gpu-image-escrow` | as gpu-image, bought through the escrow route | 0.05 | A selected; after delivery the $0.05 is locked in Masumi escrow with A as the seller (the Masumi minimum, 4.9) |
| `fractal-escrow` | fractal hd-fast, deadline 120 s, maxUsd 0.05, `exclude: [B, C]` (only A sells through escrow in this demo), bought through the escrow route | 0.05 | Fallback for the Masumi minimum when image generation isn't available: A selected; after delivery the $0.05 is locked in escrow with A as the seller |

The public run button offers a fixed list of 5 prompts. Free text exists only in the CLI and the MCP server.

### 6.5 Calibration

- Calibration is generic, built in PR-04: `packages/protocol` defines, per workload, the calibration jobs and whether their answers can be checked. The market runs them on `hello`, and again when a workload first appears in a worker's `warm` list. PR-07b then needs no market change.
- fractal: the market sets the worker to `calibrating` and dispatches `{ preset: "tiny" }` (→ `overheadSec`), then `{ preset: "calib", challenge: random 0..7, format: "raw" }`. It times dispatch → result and compares sha256(result) with `CALIB_SHA256[challenge]`. Match → `online` with `{ overheadSec, calibSec, secPerIter, verified: true }`. Mismatch → `untrusted`, which excludes the worker.
- The 8 reference hashes and the iteration totals are produced in PR-04 by running the container (`pnpm calib:ref`) and committed. Integer arithmetic makes them identical on every CPU.
- image: one timed, unverified generation at 1024², 4 steps, seed 42, a fixed prompt → `secImage1024x4` (about 10 s on A, once per join).
- Recalibrate on every reconnect. The UI shows "measured 3.1 s ✓ (answer checked)".
- Honest limit: a dishonest worker could precompute 8 answers. Next step: random views checked by recomputing sampled pixels in the market.

---

## 7. Workloads and the job sandbox

### 7.1 `workloads/fractal` (CPU)

- `python:3.12-slim` with pinned `numpy` and `pillow`. Entry: `python -m fractal '<params json>'`.
- Escape-time Mandelbrot in int64 fixed point (28 fractional bits), so results are bit-identical across CPU architectures (Intel, AMD, Apple Silicon). Escape-test before values can overflow; a unit test proves magnitudes stay below 2^31 before squaring. Supersampling averages in integers. Deterministic palette mapping.
- Parallel over row tiles with `multiprocessing`. The pool size comes from the `WORKERS` env (= `JOB_CPUS`), because `os.cpu_count()` inside a container reports the host's CPUs, not the `--cpus` quota.
- Prints `PROGRESS <0..1>` per tile. Writes `/out/result.png`, or `/out/result.bin` (uint16 little-endian iteration counts) for `format: "raw"`.
- Hashing the raw counts for calibration avoids zlib differences between PNG encoders.

### 7.2 `workloads/flux` (GPU, worker A only)

- Base: a CUDA 12.x PyTorch runtime image. Pinned: `torch`, `diffusers` (≥ 0.35; check whether the pinned version takes `torch_dtype=` or `dtype=`), `transformers`, `accelerate`, `bitsandbytes` (≥ 0.45), `sentencepiece`, `protobuf`, `huggingface_hub`, `fastapi`, `uvicorn`, `pillow`.
- `fetch_weights.py`: `snapshot_download("black-forest-labs/FLUX.1-schnell", allow_patterns=["model_index.json", "scheduler/*", "text_encoder/*", "text_encoder_2/*", "tokenizer/*", "tokenizer_2/*", "transformer/*", "vae/*"], token=HF_TOKEN, local_dir=MODELS_DIR)`. That is about 34 GB, and skips the 23.8 GB single-file checkpoint and `ae.safetensors`. It runs once, as the `flux-fetch` compose profile, the only flux container with internet access.
- `server.py` (FastAPI): at startup, load from `/models` with `PipelineQuantizationConfig(quant_backend="bitsandbytes_4bit", quant_kwargs={"load_in_4bit": True, "bnb_4bit_quant_type": "nf4", "bnb_4bit_compute_dtype": torch.bfloat16}, components_to_quantize=["transformer", "text_encoder_2"])`, bfloat16, then `.to("cuda")`, then a 1-step warm-up. Everything stays on the GPU: no CPU offload, since bf16 FLUX plus T5 (about 34 GB) exceeds the droplet's 32 GB of RAM, while NF4 needs about 10 GB of VRAM.
- `GET /health` → `{ ready, model, vramUsedGb }`. `POST /generate` {prompt, seed, size, steps} → PNG bytes; schnell uses `guidance_scale=0.0`, 4 steps, `max_sequence_length=256`. One generation at a time (a lock).
- Runs in its own compose project (`pekkah-flux`, from `deploy/flux.compose.yml`), so a worker redeploy never removes it. It has `HF_HUB_OFFLINE=1` and sits only on `pekkah-jobs`, an internal Docker network (created once by deploy.sh: `docker network create --internal pekkah-jobs`) that the worker container also joins. It cannot reach the internet; the weights are mounted read-only.
- Fallback: `FLUX_MODEL=sdxl` loads `stabilityai/stable-diffusion-xl-base-1.0` (fp16 variant, ungated, about 7 GB) with the same API, 20 steps.
- Before starting, check the disk: `df -h /` must show at least 80 GB free.

### 7.3 Sandbox rules

- Workers run only whitelisted workloads (`fractal`, `image`) and only the configured images. Params are validated with zod. Docker arguments are an array passed to `spawn`, never a shell string.
- Fractal job containers: `docker run --rm --name pekkah-job-<id> --label pekkah.job=<id> --network none --read-only --tmpfs /tmp:rw,size=64m --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory <JOB_MEMORY> --memory-swap <JOB_MEMORY> --cpus <JOB_CPUS> --user 1000:1000 -e WORKERS=<JOB_CPUS> -v /var/lib/pekkah/jobs/<id>:/out <FRACTAL_IMAGE> '<json>'`.
- Docker-out-of-Docker path rule: the worker container talks to the host's Docker through `/var/run/docker.sock`, so `-v` paths are host paths. Mount `/var/lib/pekkah` into the worker container at the same path, and create and `chown 1000:1000` each job directory before starting the job.
- Local dev on my Mac: the worker runs as a normal Node process (not in a container) with `DATA_DIR=$HOME/.pekkah/data`, since `/var/lib` needs root there. It `chown`s job directories only when running as root; otherwise it makes them writable for the job user (`chmod 0777`). Docker Desktop shares the home folder by default.
- Kill at deadline + 10 s. Cap the output at 20 MB (base64 must fit the 32 MB WebSocket limit). Delete the job directory after the result is sent.
- Image jobs are HTTP calls from the worker to the warm flux container on the internal network. The prompt is limited to 300 characters and sent as JSON.
- The worker itself is trusted (it holds the Docker socket, which is root on the host). Job containers are the untrusted part.

---

## 8. Repo layout and ownership

```
pekkah-origins/
  CLAUDE.md                     rules (A)
  README.md                     PR-11 (A)
  docs/PLAN.md                  this file (both; edits called out in the PR)
  docs/WRITEUP.md, docs/RUNS.md PR-11 / generated by demo-check (A)
  package.json, pnpm-workspace.yaml, tsconfig.base.json, biome.json, .nvmrc   (A)
  .github/workflows/ci.yml      (A)
  Dockerfile, .dockerignore     multi-target image for the Node apps (B)
  packages/protocol             schemas, presets, scenarios, events, calibration hashes (A)
  packages/matcher              pure matcher and estimates (A)
  packages/payments             x402 server helpers, PaymentOperations, receipts (A)
  packages/buyer                x402 buyer, decide, caps, events (A)
  apps/facilitator              starter port (A)
  apps/market                   Express, ws, x402, events, static web (A)
  apps/worker                   worker core (A); src/workloads/image.ts (B, PR-07b)
  apps/agent                    CLI and service (A)
  apps/web                      React + Vite UI (B)
  apps/mcp                      MCP server, bonus (B)
  workloads/fractal             CPU workload (A)
  workloads/flux                GPU server (B)
  infra/terraform               droplets, reserved IP, firewalls (B)
  deploy/                       market.compose.yml, worker.compose.yml, worker.gpu.yml (override),
                                flux.compose.yml, Caddyfile, env-examples/ (B)
  scripts/                      tf, deploy, hosts, logs, ssh, init-env, check-env, teardown,
                                flux-smoke (B); chaos, demo-check, calib-ref, inspect-job,
                                secrets-scan (A)
```

- The worker exposes a workload interface in PR-04: `apps/worker/src/workloads/<name>.ts` exports `{ name, validate, run, ready }`, registered in `workloads/index.ts`. The worker core polls `ready()` and keeps `warm[]` in sync, so a workload advertises itself only while it's ready. PR-07b adds `image.ts` (its `ready()` checks flux's `/health`) plus its one registration line; that line is the only edit Session B makes in Track A's files.
- `pnpm-lock.yaml` is shared: both sessions commit it when they add dependencies to their own packages, with the conflict rule in CLAUDE.md.
- If a session needs any other change in the other track's files (above all `packages/protocol`), it asks under ASK in its report instead of editing.
- Rebase on `origin/main` before every push.

**Deploy layout on hosts** (so the two sessions never overwrite each other):
- Each compose project has its own checkout at `/opt/pekkah/<project>` and its own compose project name: `pekkah-market` (market host), `pekkah-worker` (A, B, C), `pekkah-flux` (A only). A redeploy of one project never removes another project's containers.
- `scripts/deploy.sh` holds a local lock per host (both sessions run on my Mac; macOS has no `flock`, so the lock is an atomic `mkdir ~/.pekkah/locks/<host>.lock` that waits and retries, removed by a `trap` on exit) and writes `/opt/pekkah/<project>/DEPLOYED` (ref, sha, time, session). It refuses to replace a different non-`main` ref deployed less than 20 minutes earlier unless given `--force`, and says who deployed what.
- `/api/health` (and the worker's `hello`) report the git sha, set at build time.
- Every report says which ref is deployed where.

---

## 9. PR specs

Branches are named `pr-NN-slug`. Every PR ends with `pnpm check` green, the acceptance checks run with their evidence pasted, and a report.

### PR-01 · Foundation · Track A · gate Tue 14:00

**Objective:** a monorepo and a canonical protocol that both sessions build on.

Scope:
- pnpm workspace (`packages/*`, `apps/*`), `.nvmrc` (22), TypeScript strict ESM (`NodeNext`), Biome, Vitest. Root scripts: `check` (biome check + `pnpm -r run typecheck` + vitest run), `test`, `dev`, `secrets:scan` (gitleaks through Docker). Every package has its own `typecheck` script (`tsc --noEmit`), so packages Session B adds later (`apps/web`, `apps/mcp`) join the check without editing root files.
- `packages/protocol`: every schema in 5.1–5.4 and section 6 (types, events, WS messages, presets, scenario definitions, rejection reasons), price helpers (usd ↔ atomic, 6 decimals), constants (network, default asset, explorer URL builder). Unit tests.
- Skeletons for `apps/market` (`GET /api/health` with the git sha; static serving of `apps/web/dist` with an SPA fallback when the folder exists), `apps/facilitator`, `apps/worker`, `apps/agent` and `packages/{matcher,payments,buyer}`. Every app has `dev` and `start` scripts (`tsx src/index.ts`), which the Dockerfile relies on. Env names for local dev go in a root `local.env.example`, names only; apps load `~/.pekkah/local.env` in dev (5.5). Session B writes `deploy/env-examples/` in PR-03, with every name from 5.5.
- The protocol already includes everything later PRs rely on: `warm[]` in heartbeats, calibration job definitions per workload (6.5), the `demo` state in the `/ws/ui` snapshot, `dev: true` on events.
- `.github/workflows/ci.yml`: install with the frozen lockfile, `pnpm check`, gitleaks.
- A one-paragraph README stub in first person.

Acceptance:
- [ ] `pnpm install && pnpm check` is green locally, and CI is green on the PR.
- [ ] `pnpm --filter @pekkah/market dev`, then `curl -s localhost:8080/api/health` → `{"ok":true,...}`.
- [ ] `pnpm secrets:scan` reports no leaks.

Cut: none. This PR must merge.

### PR-02 · Payments core · Track A · gate Tue 16:30

**Objective:** a real tUSDM x402 payment from my buyer wallet to a seller chosen per request (A, B or C), settled only when the paid handler succeeds.

Scope:
- `apps/facilitator`: the starter port (4.6).
- `packages/payments`: `createResourceServer({ facilitatorUrl, timeoutMs })` registering `ExactCardanoScheme` for `cardano:preprod`; a paid-route builder with dynamic payTo and price; hook wiring that emits events; `txHashFromPaymentHeader()`; the receipt builder (uses the decoded tx for fee and minimum ADA); `PaymentOperations` (4.4). Unit tests.
- `packages/buyer`: `createBuyer()` (4.7) with all caps, the default-payment branch of the 402 check (a missing `assetTransferMethod` means default), the payment mutex, `waitForTx`, `balance` and the undici timeouts.
- `apps/market`: a dev-only smoke route, `POST /api/dev/smoke/:seller` (dev guards in 5.4), registered directly on `app` (fact 11): price $0.01 (`10000`) to `SELLER_{A,B,C}_ADDRESS`. Its handler hashes the request body (real, trivial work) or answers 500 when `?fail=1`. A test asserts that an unpaid POST gets 402.
- `apps/agent`: `pnpm --filter @pekkah/agent smoke --seller B [--fail]`. It prints the HTTP status, the txHash (computed from the signed payload) and the Cardanoscan link.

Acceptance (I open the links):
- [ ] Facilitator health is OK and `/supported` lists `exact` on `cardano:preprod` with `l1Confirmations` {minimum 0, maximum 20}.
- [ ] `smoke --seller B` → 200 and a tx link; Cardanoscan shows 0.01 tUSDM (plus minimum ADA) arriving at Seller B.
- [ ] `smoke --seller C` → a tx to Seller C. This proves payTo is dynamic.
- [ ] `smoke --seller B --fail` → 500, no `PAYMENT-RESPONSE`, tUSDM balance unchanged, and the facilitator's `GET /tx/<hash>` still answers `found: false` after 120 s.
- [ ] Unit tests: price conversion, txHash extraction, PaymentOperations claim and idempotency.

Cut and fallback: tUSDM blocked for more than 45 min → tADA prices (lovelace allowed through `allowedAssets` with a cap; prices of 2, 1.5 and 1 tADA). Dynamic payTo broken → one route per worker with a static payTo.

### PR-02m · Masumi feasibility gate · Track A · mandatory, on Tuesday · 45 min max

**Objective:** answer one question on day one: can my stack make a real Masumi escrow lock on preprod? It proves the library path, Seller A's key, my facilitator and the buyer's collateral funds long before PR-10. It's a gate, not a feature: its smoke lock does not count towards the Masumi minimum (4.9).

When (mandatory, answered on Tuesday):
- Right after PR-02 merges, if PR-02 merged by 15:45. Answer by 16:30.
- If PR-02 didn't merge by 15:45: right after PR-04 merges, so it never pushes PR-04 past its gate. Answer by 20:45.
- Never hold PR-02's or PR-04's merge for it.

Timebox: 45 minutes, a hard maximum, so it can't eat into the core build. Stop as soon as the lock is confirmed.

Scope (all of it reused by PR-10):
- `packages/payments`: the optional `masumi` option of `createResourceServer` (4.8), with the seller address check against `SELLER_A_ADDRESS`.
- `packages/buyer`: the `masumi` branch of the 402-matches-offer check (4.7).
- `apps/market`: `POST /api/dev/smoke-escrow` (dev guards in 5.4), registered directly on `app`: a Masumi template route with a static price of $0.01 (`10000`) and the library's default commitment (its URL), plus the startup `assertMasumiTemplate` check (4.8).
- `apps/agent`: `smoke --escrow`, which prints the lock tx link and the four deadlines.

Acceptance (PASS):
- [ ] `smoke --escrow` → 200; Cardanoscan shows 0.01 tUSDM plus tADA collateral locked at the Masumi escrow address, with an inline datum.
- [ ] Unit test: the buyer refuses a Masumi 402 whose seller differs from the expected address.

Outcome: the report starts with **PASS** or **FAIL**. On FAIL it names the cause and says whether it's fixable (config, funds, a misread API) or the library path itself is broken. On FAIL or timeout, stop: leave the branch unmerged as PR-10's starting point, record the cause under RISKS, and go back to the core. A FAIL is my early warning that the Cardano-track submission is at risk. Section 11 sets what happens next, and the core build continues either way.

### PR-03 · Infra and deploy · Track B · starts Tue 12:15 · gate Tue 16:30

**Objective:** three new droplets, a reserved IP and firewalls in Terraform, plus a one-command deploy of any role from the repo to any host.

Scope:
- `infra/terraform`: DigitalOcean provider (token from `DIGITALOCEAN_TOKEN`). Variables: region `tor1`, `ssh_key_ids = [59840566]`, sizes, image. A validation rule forbids any size starting with `gpu-`. A data source reads `pekkah` by name and nothing else touches it. Droplets `pekkah-market`, `pekkah-worker-b`, `pekkah-worker-c`, each with cloud-init that installs Docker (get.docker.com) and git, tagged `pekkah-demo`. A reserved IP on the market. Firewall `pekkah-market`: inbound TCP 22, 80, 443. Firewall `pekkah-workers` (B, C and the `pekkah` droplet by id): inbound TCP 22 only. **Both need explicit outbound rules for all TCP, UDP and ICMP to 0.0.0.0/0 and ::/0: DigitalOcean firewalls block outbound traffic that no rule allows.** Outputs: every IP.
- `scripts/tf.sh <init|plan|apply|destroy|output>`: runs Terraform with its state in `~/.pekkah/terraform.tfstate` (`terraform init -backend-config="path=$HOME/.pekkah/terraform.tfstate"`), so the state survives worktree removal and both checkouts share it.
- `scripts/hosts.sh`: Terraform outputs plus the `pekkah` droplet's IP → `~/.pekkah/hosts.json`.
- `Dockerfile` with targets `market` (it also builds `apps/web`), `facilitator`, `agent` and `worker` (it copies the docker CLI from `docker:27-cli`). Node apps run with tsx. A `GIT_SHA` build arg ends up in `/api/health`.
- `deploy/market.compose.yml` (project `pekkah-market`): caddy (the only service with published ports), market, facilitator and agent; per-service `environment:` lists that already include every name 5.5 gives that service (optional ones such as `SELLER_A_MNEMONIC` may be empty); a `pekkah_data` volume.
- `deploy/worker.compose.yml` (project `pekkah-worker`): the worker with the docker socket and `/var/lib/pekkah` mounted at the same path. `deploy/worker.gpu.yml`, an override for A only: a GPU reservation (`deploy.resources.reservations.devices: [{ driver: nvidia, count: 1, capabilities: [gpu] }]`) and the external `pekkah-jobs` network in addition to the default one.
- `deploy/flux.compose.yml` (project `pekkah-flux`), a stub that joins `pekkah-jobs`; PR-07a fills in the flux and flux-fetch services.
- Every long-running service has `restart: unless-stopped`.
- `deploy/Caddyfile`: `{$PUBLIC_HOST} { reverse_proxy market:8080 }` (WebSockets work as is).
- `deploy/env-examples/*.env.example` with every name from 5.5 (so later PRs need no deploy-side edits), `scripts/init-env.sh`, `scripts/check-env.sh` (5.5).
- `scripts/deploy.sh <market|a|b|c|flux|all> [--ref <branch>] [--force]`, following the deploy layout in section 8: SSH with `-o StrictHostKeyChecking=accept-new`; install git and the compose plugin if missing; create `pekkah-jobs` on A if missing; clone or fetch to `/opt/pekkah/<project>` and check out the ref; copy `~/.pekkah/env/<role>.env` with `scp` and set mode 600; build workload images on worker hosts (`docker build -t pekkah/fractal:local workloads/fractal`); `docker compose -p pekkah-<project> -f … --env-file … up -d --build --remove-orphans`; then a health check that prints the deployed sha.
- `scripts/logs.sh <role> [service]`, `scripts/ssh.sh <role>`, `scripts/teardown.sh` (`tf.sh destroy`, then a printed reminder about the `pekkah` droplet).

Acceptance:
- [ ] `scripts/tf.sh plan` shows only creates (3 droplets, 1 reserved IP, 2 firewalls) and nothing on the `pekkah` droplet. **I approve before `apply`.**
- [ ] After apply, from the `pekkah` droplet: `curl -sI https://huggingface.co | head -1` succeeds and `nvidia-smi -L` still works.
- [ ] `scripts/deploy.sh market` → `curl -s $PUBLIC_URL/api/health` is OK with the expected sha (the PR-01 skeleton).
- [ ] `scripts/deploy.sh b` and `c` → `docker compose -p pekkah-worker ps` shows the worker container up (the skeleton just logs).
- [ ] Two deploys started at once from both sessions: the second waits for the lock.
- [ ] From my Mac, `curl -m 5 http://<worker-b-ip>:8080` times out: nothing is exposed.

Cut: HTTPS. Try `PUBLIC_HOST=<ip-with-dashes>.sslip.io` first; if Caddy has no certificate after 5 minutes, use `PUBLIC_HOST=http://<reserved-ip>`.

### PR-04 · Workers, fractal and calibration · Track A · gate Tue 20:00

**Objective:** real workers dial in, report measured hardware, pass an answer-checked calibration, and run sandboxed fractal jobs.

Scope:
- `workloads/fractal` (7.1) and `pnpm calib:ref` → `CALIB_SHA256[0..7]` committed in `packages/protocol`.
- `apps/worker`: zod env config; hardware detection (`os`, plus `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader` when present); the WS client (hello, heartbeats with `warm[]`, reconnect); the workload interface with `ready()` driving `warm[]` (section 8); the fractal runner with the sandbox flags (7.3), progress parsing, result read plus sha256, kill at deadline + 10 s; one job at a time.
- `apps/market`: the `/ws/worker` server (token auth, offline after 15 s), the worker registry, generic calibration orchestration and fractal verification (6.5), `GET /api/workers`, and `POST /api/dev/dispatch {workerId, workload, params}` behind the dev guards (5.4).
- `scripts/inspect-job.sh <role>`: `docker inspect` a running job and print NetworkMode, ReadonlyRootfs, CapDrop, Memory and NanoCpus.
- Moved to PR-05 to fit the window: the `/ws/ui` broadcast and CPU/GPU utilisation in heartbeats.

Acceptance:
- [ ] Locally, market plus a worker on Docker Desktop: the worker comes online with calibration verified ✓, `overheadSec` and `calibSec`.
- [ ] Deployed to A, B and C (A's worker project only; flux is a separate project): `/api/workers` shows all three online and verified, with C's calibration slower than B's.
- [ ] A dev dispatch of the same `hd-heavy` params on B and on C returns the same sha256 (determinism across machines).
- [ ] `scripts/inspect-job.sh b` during a job shows `NetworkMode=none`, `ReadonlyRootfs=true` and `CapDrop=[ALL]`.
- [ ] `docker stop` on the worker → offline within 15 s; start → online and recalibrated.

Cut: `SCHEDULE` handling moves to PR-05.

### PR-05 · Quotes, matcher and counter-offers · Track A · gate Tue 23:00

**Objective:** the market answers a compute request with ranked offers, a market price, a counter-offer, and a reason for every rejected worker, all from measured calibration.

Scope: `packages/matcher` (6.1, 6.2) with exhaustive tests (the scenarios as fixtures, plus every rejection reason, ties and medians); `POST /api/quote`; the offer store with expiry; the `quote.issued` event; scenarios and presets tuned on real hardware against the rule in 6.3 (record the measured numbers in the PR); the `SCHEDULE` constraint; from PR-04, the `/ws/ui` broadcast (snapshot, events, workers) and CPU/GPU utilisation in heartbeats, so Session B can build the UI on live data.

Acceptance:
- [ ] Matcher tests cover every rejection reason, the median, the counter-offer and ties.
- [ ] Against live workers, each scenario's request (sent with curl) gives the expected quote: gpu-image (once A advertises `image`; otherwise checked in tests) → A; cpu-counter → no exact, counter C $0.02, market $0.03; cpu-tight → B, with A `over_budget` and C `too_slow`.
- [ ] For B and C, estimates fall within ±30% of actual runtimes (dev dispatch, then compare), and `hd-heavy` meets all four conditions of the tuning rule.
- [ ] A browser connected to `/ws/ui` receives the snapshot and live worker updates.

Cut: `SCHEDULE` (drop it; mention live hours as next).

### PR-06 · Paid end to end · Track A · gate Wed 03:00 (critical)

**Objective:** my agent buys real compute on the deployed system: quote → decide → x402 payment → the job runs on the paid worker → settlement only on delivery → receipt.

Scope:
- Market: `GET /api/tx/:hash` (5.4), and `POST /api/jobs/:offerId`, registered directly on `app` (fact 11): dynamic payTo and price from the offer, the pre-check (4.4), a handler that verifies its own precondition, reserves, dispatches, awaits, stores and responds, every hook in 4.3 including the `onBeforeSettle` skip for replays, results readable only once paid, PaymentOperations, single-use offers, `X-Pekkah-Run-Id`.
- `apps/agent`: scenario runner, decision logic with the private ceilings, events to the market (`POST /api/agent-events`), printed receipts, and the CLI `pnpm agent run <scenario> [--market <url>]`. The CLI keeps the last payment header in `~/.pekkah/last-payment.json` for `pnpm agent replay-last`.
- `scripts/chaos.sh kill-job|stop-worker|start-worker <a|b|c>` (moved here from PR-09; the acceptance needs it).
- Deploy the facilitator on the market droplet.
- Moved to PR-06b to fit the window: the agent's service mode and `POST /api/demo/run`.

Acceptance:
- [ ] An unpaid `POST /api/jobs/<offerId>` gets 402 (test and curl).
- [ ] `pnpm agent run cpu-counter --market $PUBLIC_URL` → counter accepted, job on C, 200, receipt with a tx link; Cardanoscan shows $0.02 tUSDM at Seller C.
- [ ] `pnpm agent run cpu-tight` → B paid $0.03, tx link.
- [ ] By hand: start cpu-counter, run `scripts/chaos.sh kill-job c` mid-job → the agent reports the job failed and the payment was cancelled, and `GET $PUBLIC_URL/api/tx/<hash>` answers `found: false` after 120 s.
- [ ] `GET /api/results/<jobId>` before settlement → 402 or 404; after → the PNG.
- [ ] `pnpm agent replay-last` (the same `PAYMENT-SIGNATURE` again) returns the same body and receipt, with no second job and no second tx.
- [ ] Recording #1 saved: a terminal plus Cardanoscan screen recording of two paid runs. This is insurance for the video.

Fallback: if the deployed path breaks after 01:30, record #1 from the local stack (market and worker on my Mac, real preprod payments), then fix the deploy in the morning.

### PR-06b · Hosted agent and the run button · Track A · right after PR-06 · by Wed 09:00

**Objective:** anyone with the URL can start a real paid run, and nobody can drain the wallet.

Scope: the agent's service mode (`AGENT_MODE=service`, port 4100, `POST /run {scenario, runId}` with Bearer `AGENT_TOKEN`, one run at a time, per-run and per-day caps); `POST /api/demo/run` with all its guards (5.4); the `demo` state in the `/ws/ui` snapshot and `demo` messages; the agent deployed on the market droplet.

Acceptance:
- [ ] `curl -X POST $PUBLIC_URL/api/demo/run -d '{"scenario":"cpu-tight"}'` → 202 and a full paid run in the events; a second call within the cooldown → 429; `failover` without `DEMO_TOKEN` → 403.
- [ ] With `DEMO_TOKEN`, the cooldown and the daily cap are skipped.

### PR-07a · FLUX warm server · Track B · right after PR-03 · by Tue 19:30

**Objective:** FLUX.1-schnell generates a 1024² image on the `pekkah` droplet in 20 s or less, from a warm server with no internet access.

Scope: `workloads/flux` (7.2); in `deploy/flux.compose.yml`, `flux-fetch` (profile `fetch`, default network, `HF_TOKEN`, `/var/lib/pekkah/hf:/models`) and `flux` (GPU, `pekkah-jobs` only, `HF_HUB_OFFLINE=1`, `/var/lib/pekkah/hf:/models:ro`, health check, `restart: unless-stopped`); `scripts/deploy.sh flux`; `scripts/flux-smoke.sh` (calls `/generate` from a throwaway container on `pekkah-jobs`, then copies the PNG back to my Mac).

The weights may already be in `/var/lib/pekkah/hf` (I may run the 12:00 pre-download in 13.1). `snapshot_download` with the same `local_dir` and patterns then only verifies them, so `flux-fetch` stays the single documented way to get the weights.

Timebox: 90 minutes for FLUX. After that, `FLUX_MODEL=sdxl` (ungated) with the same API.

Acceptance:
- [ ] Preflight: at least 80 GB free on `/`; `nvidia-smi` is OK; `HF_TOKEN` is set according to `check-env` (never echoed).
- [ ] `flux-fetch` completes, and `/var/lib/pekkah/hf` holds only the diffusers folders (about 34 GB, no `flux1-schnell.safetensors`).
- [ ] `/health` → ready, with at most 14 GB of VRAM in use.
- [ ] Three consecutive `/generate` calls at 1024², 4 steps, each in 20 s or less (timings printed). I look at the images.
- [ ] From inside the flux container, an HTTPS request to huggingface.co fails (no egress).

### PR-07b · Image jobs on worker A · Track B · after PR-04 merges · gate Wed 10:00

**Objective:** worker A sells image jobs, and gpu-image passes end to end twice, paid.

Scope: `apps/worker/src/workloads/image.ts` (calls the flux server, validates the prompt, checks the output; `ready()` returns flux `/health`) and its one registration line; through `ready()`, `image` is in the worker's `warm[]` only while flux says ready, which triggers the market's generic image calibration (6.5); A advertises `image` at $0.05.

Acceptance (merge on these, Tuesday night, so Session B moves on to PR-08):
- [ ] Dev dispatch of an image job on A → a PNG and a sha256; `/api/workers` shows GPU utilisation rising during the job.
- [ ] A's image calibration appears in `/api/workers` (`secImage1024x4`).

Paid check, no PR, run by Session B as soon as PR-06 has merged (planned Wednesday morning): `pnpm agent run gpu-image` twice → two images delivered and A paid $0.05 twice (tx links). This is the 10:00 gate.

### PR-08 · UI · Track B · right after PR-07b, or earlier whenever PR-07b is blocked · by Wed 13:00

**Objective:** one page that tells the story to someone new to blockchain: who sells, what my agent asked, why it chose, how it paid, what ran, and the receipt.

Scope: `apps/web` (React + Vite), served by the market at `/`. A dark theme matching the deck (`bg #0B0F19`, `card #141B2D`, `line #263049`, `text #F3F4F6`, `muted #9AA4B8`, `mint #35E0A1`, `red #FF5D5D`, `amber #FFB547`, `blue #5B8CFF`). Panels:
- Header: market status, my agent's balance (from `agent.balance`), the live/replay indicator.
- Market: one card per worker (hardware, warm chip, measured speed ✓, prices, status, CPU or GPU utilisation).
- Run: scenario buttons with the cooldown state.
- Decision: the offers table with ✓ or ✗ and a reason per worker; a counter-offer card showing the market price and my agent's choice.
- Payment timeline: 402 → signed → verified → running (progress) → delivered → settling → settled, or cancelled ("nothing was charged").
- Result: the image.
- Receipt: tx link, amount, paid-to worker, confirmations, fee and minimum ADA note. The escrow card comes in PR-08m.
- When idle: a replay of the last real run, labelled "Replay of a real run at HH:MM".

Rules: render only backend events; elapsed timers are fine, invented states are not. Fixtures load only in dev (`import.meta.env.DEV` plus `?fixture=1`) and never ship in the production bundle. The WebSocket reconnects. Works at phone width.

Acceptance:
- [ ] On the hosted URL, I watch one live run each of gpu-image, cpu-counter and cpu-tight, and every step appears in the order it happened. (Failover's rendering is checked in PR-09.)
- [ ] The run buttons show the cooldown from the `demo` state, and there is no public failover button.
- [ ] A fresh visit while idle shows the labelled replay.
- [ ] `vite build` output contains no fixture data (grep the bundle).

Cut: animations and replay → a plain page with the event log and the receipt.

### PR-08m · Escrow card · Track B · right after PR-08 · by Wed 15:00

**Objective:** the UI shows a Masumi escrow lock clearly, ready before PR-10 lands. This is presentation: the Masumi minimum's own evidence lives in the agent's receipt and the evidence block (12.3).

Scope: an escrow card in the receipt panel, built from the `escrow.locked` event schema that PR-01 put in `packages/protocol` (5.2): amount locked, collateral, seller (worker A), the request hash, the four deadlines as times, the Cardanoscan link, and the label "Locked in Masumi escrow. Release, refund and dispute tooling is my next step." For escrow runs, the payment timeline's last step reads "locked in escrow" instead of "settled", and the receipt's paid-to line reads "Locked in escrow · seller: worker A", never "paid" or "released" (4.8). Develop it against a dev fixture (`?fixture=1`, dev builds only).

Acceptance (merge on these, by 15:00):
- [ ] The card renders from the fixture in dev, and the production bundle contains no fixture data.

Real-run check, no PR, as soon as PR-10 merges: I watch one real escrow run and the card shows its real values. Fixes go in a small follow-up PR.

Cut: its extras go in the presentation cut (section 11). The whole PR is closed unmerged only if PR-10 doesn't reach the Masumi minimum.

### PR-09 · Resilience, failover and demo check · Track A · gate Wed 15:00

**Objective:** the demo works five times in a row, including a real mid-job failure that costs the buyer nothing and reroutes.

Scope:
- Agent: the failover scenario (on `job.failed` or a 502, re-quote with `exclude: [workerId]` and emit `agent.reroute`); resumed retries (re-send the same `PAYMENT-SIGNATURE` up to 3 times on a network error); late settlement (4.4).
- Market: the job timeout → fail → cancel; a worker disconnecting mid-job fails the job cleanly; rate limits; late settlement through the facilitator (4.4); a restart leaves old offers invalid, and the agent re-quotes.
- `scripts/demo-check.sh [--runs N]`: starts every run through `POST /api/demo/run` with `DEMO_TOKEN` (so it shares the hosted agent's run lock and wallet); runs gpu-image, cpu-counter, cpu-tight and failover (it calls `chaos.sh kill-job c` once C's job is running); asserts outcomes from `/api/runs/:runId/events` (worker, amount, settled or cancelled, result readable); after the loop, confirms through `GET /api/tx/:hash` that every cancelled txHash is absent on chain; appends rows to `docs/RUNS.md` (time in SGT, scenario, worker, price, tx link, duration, sha256).
- Report Blockfrost usage (I read it on the Blockfrost dashboard) and DigitalOcean month-to-date spend (`doctl balance get`).

Acceptance:
- [ ] `scripts/demo-check.sh --runs 5` → 5/5 PASS, as a printed table.
- [ ] `docs/RUNS.md` lists at least 15 real tx hashes.
- [ ] Failover: C's job failed, C's signed tx never reached the chain, and B was paid.
- [ ] I watch one failover run in the UI: failed, "nothing was charged", rerouted, paid.

If failover works and `demo-check.sh` is built but 5/5 hasn't passed by 15:00, PR-09 merges anyway at 15:00 with the runs so far in the report, and PR-10 starts (the Masumi minimum needs its time). Failover itself is core and always comes before PR-10.

After PR-10 merges, these happen in order, never overlapping, because they share the buyer's wallet and a redeploy restarts the market: (1) PR-08m's real-run check (it can reuse PR-10's acceptance run if I watched it in the UI); (2) the leftover runs to reach 5/5, as a no-PR check, unattended while PR-11's docs are written; (3) PR-11's redeploy, which waits until the runs finish.

### PR-10 · Masumi minimum · Track A · starts when PR-09 merges (at 5/5, or at 15:00 at the latest once failover works and `demo-check.sh` is built) · required for the Cardano track

This PR delivers the Masumi minimum (4.9), which the Cardano-track submission needs. It comes right after the core, ahead of every presentation item and bonus. If PR-02m passed, the payment path is proven and this PR is wiring. If PR-02m failed or ran out of time, this PR starts from its branch and its note.

**Objective:** a real job, chosen and paid for by my agent, whose payment is locked in Masumi's escrow on preprod after the job delivers: the selected worker is the seller, the escrow is bound to the exact request, and the evidence is complete. Nothing is released to the worker.

Scope (4.8, 4.9):
- `POST /api/escrow-jobs/:offerId`, registered directly on `app`, reusing the paid handler, pre-check and hooks of `/api/jobs/:offerId`; dynamic price from the offer; the commitment bound to `offer.request`; escrow purchases only for offers whose worker is the Masumi seller (worker A); a rate limit on unpaid 402s.
- In the agent: the `gpu-image-escrow` scenario (quote as gpu-image, then buy through the escrow route) and its fallback `fractal-escrow` (6.4). Receipts for escrow runs say "locked in escrow" and print the fields of 4.9 point 6. Both scenarios also run through the agent service, for `demo-check --escrow` (`DEMO_TOKEN` only, never public).
- The `escrow.locked` event with deadlines and collateral (from the decoded tx and `extra.terms`).
- `scripts/demo-check.sh --escrow`: one escrow run at the end (never inside the 5/5 loop: locked funds stay locked). It checks the conditions in 4.9 and writes the evidence block (12.3) to `docs/RUNS.md`.
- The UI side is PR-08m (Track B).

Acceptance (the Masumi minimum, 4.9):
- [ ] `pnpm agent run gpu-image-escrow` (or `fractal-escrow`, see 4.9) → the job delivers, then 200 with a receipt where `transferMethod` is `masumi` and the wording says "locked in escrow".
- [ ] Cardanoscan shows the tUSDM and collateral locked at the escrow address, with an inline datum.
- [ ] The seller in the terms is the worker the matcher selected, and `terms.inputHash` is the commitment to the request the agent quoted.
- [ ] `scripts/demo-check.sh --escrow` → PASS, and `docs/RUNS.md` has the evidence block with every field from 12.3.
- [ ] The `escrow.locked` event carries real deadlines and collateral (the evidence block and PR-08m's card read them).

Cut: only scope beyond the minimum (PR-10b, more scenarios, escrow card extras). The minimum itself is never cut. If it isn't reached by the 17:00 freeze, it alone continues until 18:00 at the latest, and PR-11 then has 18:00 to 19:00. If it still isn't reached at 18:00, it is unreachable for this submission: the main track goes ahead and the Cardano track is not ready. Never close this PR silently; the report says exactly what is missing.

PR-10b (a bonus, Session A): worker A submits the result hash on chain, in my own code with the CF demo as a reference. Only after PR-11 is merged and only if it can finish before the 17:00 freeze; never started after 16:00.

### PR-11 · Release · Track A · right after PR-10 merges (at 18:00 at the latest if the Masumi minimum ran over) · by Wed 19:00

**Objective:** a judge can understand, verify and run the project from the repo in five minutes.

Scope:
- README in first person: what and why (3 lines), the live URL, an architecture diagram (Mermaid, which GitHub renders), how payment works in 6 steps, real tx hashes (from `docs/RUNS.md`), the Masumi evidence block (12.3), how to run locally, how to run a worker, honest limits (section 14).
- `docs/WRITEUP.md`: the problem; the approach (x402, `@x402/cardano`, the facilitator, Blockfrost, tUSDM, eUTxO, Masumi: what is real today, the escrow lock, and what is next: release, refund and dispute); deploy and scale; next steps (prepaid deposits with batched settlement, Masumi release, refund and dispute, open registration with recomputation checks, distributed jobs, live hours).
- No licence file unless I decide otherwise (without one, all rights are reserved).
- `pnpm secrets:scan` is clean. A fresh clone into a temp directory passes `pnpm install && pnpm check`. Dev routes off in production: I remove `PEKKAH_DEV_ROUTES` from `~/.pekkah/env/market.env`, Claude redeploys and checks that `/api/dev/*` answers 404. Tag `v0.1.0`.

Acceptance:
- [ ] Fresh clone check passes; gitleaks is clean.
- [ ] The README renders its diagram on GitHub.
- [ ] The live URL works in a private window.
- [ ] README and write-up describe the Masumi run as funds locked in escrow, never as the worker being paid.

### B1 · MCP server (bonus) · Track B · only after PR-10's Masumi minimum acceptance has passed and PR-08m has merged

**Objective:** Claude buys an image from Pekkah with a tool call.

Until PR-10's acceptance passes, Session B doesn't start B1. In order, it works on: PR-08m; the Masumi UI and evidence (the escrow card against the real run, evidence screenshots for the README and deck); regressions (the UI against live events); recording support (the UI states the video needs); and core fixes inside Track B's files (anything in Track A's files goes to ASK). It never runs paid scripts while Session A is testing payments.

Scope: `apps/mcp`, a stdio server on `@modelcontextprotocol/sdk` with the tools `pekkah_market` (workers and prices) and `pekkah_generate_image({ prompt, maxUsd ≤ 0.10 })`. It uses `packages/buyer` and returns the image as MCP image content plus a text receipt. Setup notes go in `apps/mcp/README.md` (the root README is Track A's): a `claude_desktop_config.json` snippet with names only (the mnemonic lives only on my Mac). It uses the same buyer account as the hosted agent, so I don't run it while a hosted run is in progress; a collision costs at most one failed payment, never a double charge.

Acceptance:
- [ ] In a Claude chat: "Use Pekkah to make an image of a lighthouse at dusk, at most 5 cents" → the image plus a tx link, and the tx is on Cardanoscan.

---

## 10. Timeline and gates (SGT)

This table is the plan at the latest. When a session is ahead, it starts its next PR immediately and every later row moves earlier; gates never move later. When a session's next PR is blocked by the other session, it starts its next unblocked PR (or a local-only part of the blocked one) and says so in its report.

What each PR waits for (merged = on `main`):

| PR | Can start when | Its acceptance also needs |
| --- | --- | --- |
| PR-01 | 12:00 | |
| PR-02 | PR-01 | |
| PR-02m | PR-02, if PR-02 merged by 15:45; if not, right after PR-04 (mandatory, answered by 16:30 or 20:45) | |
| PR-03 | 12:00 (rebase once PR-01 merges) | PR-01 for the deploy checks |
| PR-04 | PR-01 | PR-03 for the deploy checks |
| PR-05 | PR-04 | |
| PR-06 | PR-05 and PR-02 | PR-03 |
| PR-06b | PR-06 | |
| PR-07a | PR-03 | |
| PR-07b | PR-04 and PR-07a | PR-06 for the paid check |
| PR-08 | PR-01 (fixtures); live data after PR-05 and PR-06 | PR-06b for the run buttons |
| PR-08m | PR-08 | (the real-run check after PR-10 is a no-PR check) |
| PR-09 | PR-06b and the paid gpu-image check | |
| PR-10 | PR-09 merged (at 5/5, or at 15:00 at the latest once failover works and `demo-check.sh` is built); PR-02m's result (PASS, or its branch and note) | |
| PR-11 | PR-10 merged, or 18:00 at the latest (PR-10's cut rule) | |
| PR-10b | PR-11 merged, and only before 16:00 | |
| B1 | PR-10's Masumi minimum acceptance passed, and PR-08m merged | |

| Planned (latest) | Session A | Session B | Gate (deadline) |
| --- | --- | --- | --- |
| Tue 12:00–12:15 | I create the repo and open both sessions (13.1) | | |
| 12:15–14:00 | PR-01 | PR-03 (Terraform first) | PR-01 merged by 14:00 |
| 14:00–16:30 | PR-02, then the PR-02m Masumi feasibility gate if PR-02 merged by 15:45 | PR-03 (deploy, after rebasing on PR-01) | Real tUSDM to two sellers; infra live; PR-02m answered (if it ran), by 16:30 |
| 16:30–20:00 | PR-04 | PR-07a (90-min FLUX timebox, then SDXL) | PR-04 by 20:00 |
| 20:00–23:00 | PR-02m first if PR-02 didn't merge by 15:45 (max 45 min), then PR-05 | PR-07b worker side, then PR-08 | PR-02m answered by 20:45; PR-05 by 23:00 |
| 23:00–03:00 | PR-06 and recording #1 | PR-08 | PR-06 by Wed 03:00 |
| 03:00–07:30 | Sleep, starting as soon as PR-06 is merged | Sleep (optional: a local-only UI task, no deploys) | |
| Wed 07:30–10:00 | PR-06b (until 09:00), then start PR-09 | Paid gpu-image check twice (no PR), PR-08 on live data | GPU paid end to end twice by 10:00 |
| 10:00–13:00 | PR-09 | Finish PR-08 | PR-08 by 13:00 |
| 13:00–15:00 | PR-09 demo-check 5/5 | PR-08m escrow card, then regressions and recording support | PR-09 and PR-08m by 15:00 |
| 15:00–17:00 | PR-10, the Masumi minimum (from the moment PR-09 merges, 15:00 at the latest) | Masumi UI and evidence support, core fixes; B1 only after PR-10's acceptance | Masumi minimum and feature freeze by 17:00 (earlier if PR-10 is done) |
| 17:00–19:00 | PR-11; the PR-08m check, then leftover 5/5 runs, finish before PR-11's redeploy (PR-11 starts at 18:00 at the latest if the Masumi minimum ran over) | Bug fixes only | |
| 19:00–20:30 | I record and cut the video | | |
| 20:30–22:00 | Deck (real numbers, URL, embedded video) and write-up | | |
| 22:00–23:00 | Submit: main track, then the Cardano track (only with the Masumi minimum and its evidence) | | Hard deadline 23:59 |
| Thu 12:00 | Top 5 call. Not selected → teardown. Selected → keep everything up until 17:00 | | |

PR-10 starts the moment PR-09 merges: at 5/5, even if that's before 15:00, and at 15:00 at the latest once failover works and `demo-check.sh` is built. The 17:00 freeze holds for everything except the Masumi minimum, which continues until 18:00 at the latest if it isn't reached by 17:00 (PR-10's cut rule). Everything after the freeze (PR-11, video, deck, submission) also moves earlier when the build finishes early; the extra time becomes buffer before the 23:59 deadline. Session B builds the escrow card (PR-08m) right after PR-08, so it's ready when PR-10 lands, and starts B1 only after PR-10's acceptance passes.

---

## 11. Cut order and fallbacks

Cut in this order when behind, following the priorities in section 0:
1. Bonuses: B1 MCP → PR-10b and any other Masumi scope beyond the minimum that isn't UI → live hours (`SCHEDULE`).
2. Presentation: UI animations and replay → HTTPS → the escrow card's extras (the receipt and the evidence block stay).
3. GPU images: fall back to the CPU-only demo; the Masumi minimum then uses `fractal-escrow` (4.9).

Never cut: real payments, settle-on-delivery, real workers, failover, the Masumi minimum (4.9), and the required deliverables (video, deck, README, write-up; kept simple when short of time). If the Masumi minimum is still not reached at 18:00, it is unreachable for this submission: the main track goes ahead and the Cardano-track submission is not ready.

| Risk | Trigger | Fallback |
| --- | --- | --- |
| Dynamic payTo fails | PR-02 not working by 16:00 | One route per worker with a static payTo |
| tUSDM fails | Blocked for 45 min | tADA prices with an `allowedAssets` cap |
| FLUX fails | 90-min timebox | SDXL base 1.0 → a GPU-computed render served through the same `image` workload API (a timed torch render as a PNG), so the whitelist stays `fractal` and `image` → a CPU-only demo |
| GPU droplet lost | the `pekkah` droplet dies | Three CPU workers. I run my GPU hunt script by hand (`~/Developer/scratch/gpu-hunt.sh`); Claude never creates GPU droplets |
| Settlement slow | p50 above 60 s in rehearsal | Keep 0 confirmations and speed up the video edit, with an on-screen label |
| UI late | 13:00 gate | A plain page with the event log and the receipt |
| Masumi feasibility gate fails on Tuesday | PR-02m reports FAIL | Fixable (config, funds, a misread API): PR-10 starts from the branch with the fix. Library path broken: the Cardano-track submission is at risk, and I know on Tuesday. PR-10 still runs at its normal time and never takes time from the core; the Cardano track is only given up if the minimum is still unreached at 18:00 Wednesday |
| Masumi minimum not reached on Wednesday | 17:00 | It alone continues until 18:00 at the latest (PR-11 moves to 18:00–19:00). Still not reached at 18:00: submit the main track only, Cardano track not ready. The write-up stays honest either way |
| Blockfrost quota | 402 or 429 from Blockfrost | A second project ID for the agent; or the $29 plan |
| Venue blocks SSH | deploy fails | Phone hotspot, or the DigitalOcean web console |
| Claude usage limits | either session throttled | One session; Track A first |

---

## 12. Demo check, recording and submission

### 12.1 Video, 3:00 or less (recorded from the hosted UI, plus a terminal for chaos)

| Time | Scene |
| --- | --- |
| 0:00 | The market: three real workers, measured speeds, prices |
| 0:15 | gpu-image: request → only A fits → 402 → signed → GPU busy → image → settled, A paid (Cardanoscan) |
| 1:00 | cpu-counter: no match → market price → counter-offer → accepted → C paid |
| 1:35 | cpu-tight: A over budget, C too slow (measured) → B paid |
| 2:05 | failover: I kill C's job → nothing charged → rerouted → B paid |
| 2:35 | Masumi (required for the Cardano submission): the agent buys a job through escrow → the job delivers → the payment is locked in Masumi's escrow with A as seller, bound to the request; the escrow card and Cardanoscan show the tx, the inline datum and the deadlines. Said as "locked in escrow", never "paid" |
| 2:50 | "Any machine sells. Any agent buys. Paid per job on Cardano." |

If the Masumi minimum wasn't reached, the video drops the 2:35 scene and the Cardano track isn't submitted as ready. Never show `.env` files or a terminal that prints secrets. Label any sped-up section.

### 12.2 Submission checklist

- [ ] Main track submitted first.
- [ ] Cardano Agentic Commerce track added, only if the Masumi minimum passed: the evidence block (12.3) is in `docs/RUNS.md` and the README, the video has the Masumi scene, and the write-up describes the lock precisely.
- [ ] Public repo with README, diagram and tx hashes.
- [ ] Hosted URL works in a private window, and the run button is guarded.
- [ ] Keynote with the video embedded, uploaded to Google Drive, link shared as "anyone with the link".
- [ ] Video, 3:00 or less.
- [ ] Write-up pasted.

### 12.3 Masumi evidence block

`scripts/demo-check.sh --escrow` (PR-10) writes this block to `docs/RUNS.md` from the run's events, and PR-11 copies it into the README. Every field comes from a real run:

| Field | Source |
| --- | --- |
| Run | scenario (`gpu-image-escrow` or `fractal-escrow`), runId, time (SGT) |
| Compute | selected worker and its hardware, workload, duration, result sha256 |
| Lock tx | tx hash, with its Cardanoscan link |
| Escrow address | Masumi `vested_pay` V2 on preprod (the route's payTo) |
| Seller | the selected worker's id and address (`terms.sellerAddress`) |
| Request hash | `terms.inputHash`, the commitment to the quoted request |
| Amount and asset | tUSDM amount locked, plus the tADA collateral |
| Inline datum and deadlines | inline datum present on the escrow UTxO (check on Cardanoscan); pay by, submit result, unlock, dispute times |
| Status | "Locked in Masumi escrow. Release, refund and dispute tooling is my next step" |

---

## 13. Ops runbook

### 13.1 Tue 12:00: repo and sessions

In Terminal:

```bash
mkdir -p ~/.pekkah/env ~/.pekkah/locks && chmod 700 ~/.pekkah
cd ~/Developer
gh repo create pekkah-origins --public --clone --description "Compute that AI agents can buy: a pay-per-job GPU and CPU market, paid with x402 on Cardano"
cd pekkah-origins
mkdir -p docs
mv ~/Downloads/CLAUDE.md ./CLAUDE.md
mv ~/Downloads/PLAN.md ./docs/PLAN.md
sed -n '/^### 13.2/,/^### 13.3/p' docs/PLAN.md | sed -n '/^```$/,/^```$/p' | sed '1d;$d' > .gitignore   # the .gitignore from 13.2
git add -A
git commit -m "Plan and rules for the build (written before kickoff, no code)"
git branch -M main
git push -u origin main
```

Then my local secrets file, which PR-02 needs by 14:00 (Session B's `init-env.sh` adds the other names later without touching these):

```bash
umask 077
cat > ~/.pekkah/local.env <<EOF
# Pekkah local dev. Fill every __FILL_ME__ in a text editor. Never paste values into chat.
BLOCKFROST_PROJECT_ID=__FILL_ME__
BLOCKFROST_BASE_URL=https://cardano-preprod.blockfrost.io/api/v0
BUYER_MNEMONIC="__FILL_ME__"
SELLER_A_ADDRESS=__FILL_ME__
SELLER_B_ADDRESS=__FILL_ME__
SELLER_C_ADDRESS=__FILL_ME__
SELLER_A_MNEMONIC="__FILL_ME__"
PEKKAH_ASSET=e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d
PEKKAH_DEV_ROUTES=1
DEMO_TOKEN=$(openssl rand -hex 16)
AGENT_TOKEN=$(openssl rand -hex 16)
EOF
open -e ~/.pekkah/local.env
```

On the GPU droplet (optional but recommended, run by me at 12:00 so the weights are on disk hours before PR-07a):

```bash
ssh root@159.203.0.34
tmux new -s flux                      # survives a dropped connection; Ctrl-B then D to detach
read -rs HF_TOKEN && export HF_TOKEN  # paste the Hugging Face Read token; nothing is echoed or saved
mkdir -p /var/lib/pekkah/hf
docker run --rm -e HF_TOKEN -v /var/lib/pekkah/hf:/models python:3.12-slim sh -c \
  'pip install -q huggingface_hub && hf download black-forest-labs/FLUX.1-schnell --local-dir /models --include "model_index.json" "scheduler/*" "text_encoder/*" "text_encoder_2/*" "tokenizer/*" "tokenizer_2/*" "transformer/*" "vae/*"'
du -sh /var/lib/pekkah/hf             # about 34 GB when done
```

Running it in a throwaway container avoids installing anything on the droplet and leaves no token on its disk. PR-07a's `flux-fetch` then finds the files and only verifies them.

Claude desktop app, Code tab:
1. Session A: New session → Local → folder `~/Developer/pekkah-origins` → mode Auto. Type `/cardano-context`, then paste kickoff A.
2. Session B: New session → Local → same folder → turn on worktree → mode Accept edits until PR-03 merges, then Auto. Paste kickoff B.

Kickoff A:

> You are Session A on Pekkah. Read CLAUDE.md and docs/PLAN.md completely before doing anything. Your track is A: PR-01, PR-02, PR-02m (the mandatory Masumi feasibility gate: right after PR-02 if it merges by 15:45, otherwise right after PR-04), PR-04, PR-05, PR-06, PR-06b, PR-09, PR-10 (the Masumi minimum, required for the Cardano track), PR-11, then PR-10b only if PLAN's rules allow it. Start PR-01 now on branch pr-01-foundation. Build exactly the PR's scope, run its acceptance checks yourself, open the PR with gh, and send the report format from CLAUDE.md. While I review, start your next PR locally as CLAUDE.md describes. Gates are deadlines, not start times: whenever you finish early, keep going.

Kickoff B:

> You are Session B on Pekkah, working in this worktree. Read CLAUDE.md and docs/PLAN.md completely before doing anything. Your track is B: PR-03, PR-07a, PR-07b, PR-08, PR-08m. B1 starts only after PR-10's Masumi minimum acceptance has passed and PR-08m has merged; until then follow the priorities in PLAN's B1 section. Start PR-03 now on branch pr-03-infra from origin/main, Terraform first. Touch only the files Track B owns (PLAN section 8). Show me the terraform plan and get my approval before apply; keep building the deploy scripts while you wait for it. When the acceptance checks pass, open the PR with gh and send the report format from CLAUDE.md. While I review, start your next PR locally as CLAUDE.md describes. Gates are deadlines, not start times: whenever you finish early, keep going.

### 13.2 `.gitignore`

```
# dependencies and builds
node_modules/
dist/
.vite/
*.tsbuildinfo
coverage/

# secrets (never commit; real ones live in ~/.pekkah, these are safety nets)
.env
.env.*
!.env.example
*.env
!*.env.example
.pekkah/
deploy/env/
deploy/hosts.json
*.pem
id_rsa*
id_ed25519*

# terraform
.terraform/
*.tfstate
*.tfstate.*
*.tfplan
tfplan
crash.log

# runtime data
results/
*.log

# OS and editors
.DS_Store
.idea/
.vscode/
```

### 13.3 Day to day

- Deploy: `scripts/deploy.sh <market|a|b|c|flux|all> [--ref <branch>]`. Never during a recording.
- Logs: `scripts/logs.sh <role> [service]`. Shell: `scripts/ssh.sh <role>`.
- Env: `scripts/init-env.sh` once (it writes `~/.pekkah/local.env` and `~/.pekkah/env/*.env`), then I fill the `__FILL_ME__` values in a text editor; `scripts/check-env.sh` before every deploy.
- Terraform: always through `scripts/tf.sh` (state in `~/.pekkah`).
- Git in both sessions: never check out `main` (the sessions share one repo through a worktree, and a branch can be checked out in only one place). Merge with `gh pr merge <number> --squash`, delete the remote branch with `git push origin --delete <branch>`, then `git fetch origin` and branch the next PR from `origin/main`.
- Chaos: `scripts/chaos.sh kill-job c`, `stop-worker c`, `start-worker c`.
- Spend: `doctl balance get` at every gate.

### 13.4 Teardown (Thursday)

1. `scripts/teardown.sh` → `terraform destroy` (market, B, C, the reserved IP, both firewalls). I approve.
2. I delete the `pekkah` droplet myself, after the Top 5 call (or after 17:00 if selected): `doctl compute droplet delete pekkah`.
3. `doctl compute droplet list` is empty; the billing page shows no running resources.

---

## 14. Known risks and honest limits

These go into the README and the write-up as they are.

- Preprod only, paid in test tokens.
- Workers join by allowlist (one token each) for the demo. Open registration is next.
- CPU work is answer-checked at calibration, not on every job. GPU work is timed, not verified.
- Between verification and settlement, the market holds the buyer's signed transaction. If the job fails, the market discards it, but a dishonest market could still broadcast it before its 10-minute TTL. Escrow is the fix: with Masumi the money sits in a contract bound to the request, not with the market or the worker. Today I can lock into Masumi's escrow; release, refund and dispute tooling is the next step, and until it exists my test locks stay locked.
- The reverse risk also exists: a buyer could spend the same inputs elsewhere before settlement. The worker then loses that job's compute, but the market withholds the result.
- Every token payment carries about 1.2 tADA of minimum ADA, which makes sub-cent payments uneconomic on mainnet today. Next: prepaid deposits with batched settlement. No credit for anonymous agents.
- One market instance with in-memory state. A restart drops open offers; agents re-quote.
- For Masumi, the market holds Seller A's key to sign the escrow terms, so in this demo the market could also spend Seller A's funds. Next: the worker signs the terms itself over its WebSocket (the library's `signTerms` may be async).

---

## 15. References

- x402 Cardano scheme spec: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_cardano.md
- `@x402/cardano` source and README (Apache-2.0): https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/cardano
- Express starter (MIT): https://github.com/cardano-foundation/developer-portal/tree/main/examples/templates/x402-express
- CF x402 demo (no licence; read only): https://github.com/cardano-foundation/x402-cardano-demo
- x402 on Cardano, for agents: https://developers.cardano.org/x402/agent.md
- tUSDM faucet: https://tusdm.moneta.global · tADA faucet: https://docs.cardano.org/cardano-testnets/tools/faucet
- Masumi x402: https://www.masumi.network/x402
- FLUX.1-schnell: https://huggingface.co/black-forest-labs/FLUX.1-schnell
- Diffusers quantization: https://huggingface.co/docs/diffusers/main/en/quantization/overview
- DigitalOcean firewall (Terraform): https://docs.digitalocean.com/reference/terraform/reference/resources/firewall
