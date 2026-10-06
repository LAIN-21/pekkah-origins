# Pekkah Phase 2 plan

Written Tuesday 6 October, in the evening. Phase 1 (PR-01 to PR-11, PR-10b and B1) merged ahead of schedule and is live. This file is the spec for Phase 2, up to the Wednesday 17:00 freeze and the submission. `CLAUDE.md` holds the rules. `docs/PLAN.md` stays the Phase 1 spec; for Phase 2 work, this file wins where they differ.

## Contents

0. How to use this plan
1. What Phase 2 adds
2. Facts I verified
3. The demo
4. Rule changes
5. Sessions and ownership
6. PR specs
7. Timeline and gates
8. Cut order and fallbacks
9. Operations
10. Recording
11. Honest limits after Phase 2
12. Kickoff
13. Thursday

---

## 0. How to use this plan

**Priorities, in order.** When anything competes for time, the higher level wins:
1. **Keep what's live working.** The hosted scenarios (gpu-image, cpu-counter, cpu-tight, failover, gpu-image-escrow) stay green, and the Masumi minimum's evidence stays valid. `scripts/demo-check.sh --runs 1` passes after every market deploy.
2. **The Phase 2 core.** Escrow release (PR-16), my agent shopping in Claude (PR-14), the live-follow UI (PR-15) and the worker kit (PR-17, PR-17w, PR-18).
3. **A safe recording.** Safety takes, rehearsals and `?run=`.
4. **Bonuses.** PR-16b (refund of no-result locks) first, then anything else in the cut order.

- Three Claude Code sessions build in parallel: A, B and C (section 5).
- The Phase 1 working rules hold. Gates are deadlines, never start times. Timeboxes are maximums. No padding. When blocked, start the next unblocked PR (or a local-only part of the blocked one) and say so in the report.
- Paid runs never overlap, across all sessions (9.3).
- If something here proves wrong, fix it in the PR, say so under RISKS, and correct this file in the same PR.

---

## 1. What Phase 2 adds

1. **Escrow release.** The escrow loop closes on preprod: the lock (PR-10), the result hash on chain (PR-10b), then the release to worker A after the unlock time, with the buyer's collateral returned (PR-16).
2. **A demo told from the agent's side.** In Claude Code, with the Pekkah MCP and a skill, my agent looks at the market, gets quotes and keeps to my budget. When nothing fits the budget, it asks me in one line ("I found it for 5 cents, OK?"). Then it buys a FLUX image through Masumi escrow, and the web UI follows every step live.
3. **The worker kit.** Any Linux machine with Docker installs the worker with one command. The worker reads its own hardware, runs a local benchmark and joins the market on probation: listed and measured, but it sells nothing until I allowlist it. It doesn't have to be in the video, but it must exist and work.

Decisions (Tuesday evening):
- FLUX images stay the only GPU job. No new workload.
- Release gets built. Refund of no-result locks is the first bonus. Dispute is next, and not built.
- Open join exists only with `OPEN_WORKER_JOIN=1`, which I set on the hosted market. Probation workers never sell.
- Cut now: arm64 images, and `gpus[]`/`offered` in the hardware report.
- Images are amd64 only, on public GHCR packages.
- The install test runs on a fresh GitHub-hosted Ubuntu runner, because I have no spare droplet. An AWS G instance is optional, for the GPU path, and I launch and terminate it myself (9.6).
- The over-budget ask is enforced in the MCP tool, not only in the skill. The tool records my agent's statement that I approved; that statement is not proof. The wallet's spend caps stay the hard limit.

---

## 2. Facts I verified

### 2.1 The code today

- **Joining is closed.** `WORKER_TOKENS` is a static allowlist (`apps/market/src/workers.ts`, `onHello`). No image is published, there is no installer, and the README's worker steps are clone and build.
- **Hardware is reported, speed is measured.** The market stores `hello.hardware` as sent, and the matcher reads `gpu.vramGb` from it. CPU calibration answers are checked; GPU calibration is only timed.
- **Hello strings are unbounded.** `cpuModel`, `gpu.name`, `driver`, `version` and `schedule` have no maximum (`packages/protocol/src/worker.ts` and `ws-worker.ts`). `name` is at most 64 characters.
- **The worker doesn't recover from refusal or change.** It builds `hello` once at start (`apps/worker/src/index.ts`), reports only the first GPU (`hardware.ts`), and keeps reconnecting every 5 s after `unauthorized` (`agent.ts`).
- **The MCP decides by itself.** It has three image-only tools. `choose()` never accepts a counter-offer above `maxUsd`, which is both the budget and the ceiling (`apps/mcp/src/pekkah.ts`). It never uses escrow, and it labels every run `gpu-image`.
- **The MCP runs from Session B's Phase 1 worktree** (my Claude Desktop config points at it). It reads its env from `~/.pekkah/env/market.env`, and entries in the Claude config's `env` win over the file.
- **The UI.**
  - The run log has no scroll handling, and `escrow.result_submitted` renders as a bare "Event" (`describe.ts`).
  - A run opened mid-way shows as a replay.
  - The page always shows the run with the newest `run.started`, so an older run's release is off screen unless the page can open that run (`?run=`).
- **The run button** refuses a second hosted run (409), but it doesn't know about MCP runs (`apps/market/src/demo.ts`).
- **RunStore** keeps the last 30 runs in `DATA_DIR/runs`, so pending releases survive a restart.
- **Worker A has room.** FLUX holds 13.1 of 20.5 GB of VRAM, and 425 GB of disk are free.

### 2.2 Masumi `vested_pay` V2 (checked against the source)

- The compiled validator in `apps/market/src/masumi-validator.ts` is byte-identical to `compiledCode` in Masumi's `smart-contracts/payment-v2/plutus.json` on `main` (commit `d569a33`, checked Tuesday 6 October). So `smart-contracts/payment-v2/validators/vested_pay.ak` on `main` is the contract my locks sit in.
- Redeemer indexes: Withdraw 0, SetRefundRequested 1, AuthorizeWithdrawal 2, WithdrawRefund 3, WithdrawDisputed 4, SubmitResult 5, AuthorizeRefund 6.
- **Withdraw (the seller collects).**
  - The datum's seller key (Seller A) signs.
  - The state is ResultSubmitted, and the validity range starts at or after `unlock_time`.
  - State WithdrawAuthorized skips the wait, but the buyer can only authorize from Disputed, so a normal buy has no honest early release.
  - The validity range must have a finite upper bound.
  - No output at the escrow address may carry the same `reference_signature` (no continuing escrow).
  - Tagged outputs must pay at least `collateral_return_lovelace` to `buyer_return_address`, or to `buyer` when that field is empty. The tag is an inline datum holding the spent UTxO's reference: the Plutus V3 `OutputReference`, `Constr 0 [tx hash bytes, output index]`, not the V2 nested-TxId shape. Address equality includes the stake credential.
  - If `seller_return_address` is set, tagged outputs to it must carry the input value minus the collateral. My locks leave both return addresses empty (the buyer and the market never set them), so the seller's output is unconstrained.
  - Masumi's own builder (`packages/payment-source-v2/src/builders/withdrawal-outputs.ts`) tags every withdrawal output with `mOutputReference(txHash, index)` and funds each output's min-ADA from the builder's wallet. I do the same.
- **WithdrawRefund (the buyer takes back a lock with no result).**
  - The buyer key signs.
  - The state is FundsLocked (or RefundRequested, or RefundAuthorized).
  - The validity range starts at or after `submit_result_time` (not needed once RefundAuthorized).
  - `result_hash` is empty, and there is no continuing escrow.
  - With `buyer_return_address` empty, the destination is free.

### 2.3 `@x402/cardano` 2.26.0 (checked at the `npm-@x402/cardano@v2.26.0` tag)

- `payByTime` is now + `maxTimeoutSeconds`. `masumi.deadlines` sets offsets from `payByTime`: `submitResultAfterPayByMs`, `unlockAfterPayByMs` and `externalDisputeUnlockAfterPayByMs`. The defaults are 15, 35 and 55 minutes, so today's unlock comes about 45 minutes after the 402.
- **Minimum gaps**, applied by the issuer, the buyer and the facilitator:
  - pay by → submit result: 5 minutes
  - submit result → unlock: 15 minutes
  - unlock → dispute: 15 minutes
- The issuer also refuses a submit deadline less than 15 minutes after issuance. So the unlock can never come earlier than 30 minutes after the 402, whatever `maxTimeoutSeconds` is.
- **PR-16's offsets are 6, 21.5 and 37 minutes.** They clear every minimum by at least 30 s.
  - The submit deadline lands 16 minutes after the 402: the 15-minute lead plus 1 minute, which covers the seller's signing time.
  - The unlock lands about 31.5 minutes after the 402. That's the floor plus margins: no tweak gets it lower.
- `unsafeSkipPolicyChecks` is test-only, and the buyer refuses the deadlines it lets through. Never use it.
- `parseMasumiLockDatum` is exported and parses any state. It returns addresses as credentials (payment and stake), so the release builder rebuilds the exact address.
- **The release's lovelace.** The library requires locked lovelace = requested lovelace + `collateral_return_lovelace`, exactly. For tUSDM, the escrow's lovelace is therefore exactly the collateral (4.00399 tADA in my runs).
  - At release, all of it goes back to the buyer.
  - Seller A pays the fee and the min-ADA of its tUSDM output (about 1.2 tADA) from its own UTxOs, not from its collateral reserve.
- A lock made by this library can't be driven by `masumi-payment-service`, because the seller signature covers a different payload. Result, release and refund need x402-aware tooling that holds the right key: that's PR-10b, PR-16 and PR-16b.

### 2.4 Chain state to use

| Lock | Run | State | Use |
| --- | --- | --- | --- |
| 18:24, `ae0a2d86…7099` | `01M48BXBXCXQ4RPXD9RFB9WZFY` | ResultSubmitted; unlocked since 19:09:58 | The spike's dry run, then PR-16's first real release |
| 16:34, `92787101…c4de` | `01M485KG1XAB9W93HGFDNAPK77` | FundsLocked; submit deadline (16:59:43) passed | PR-16b's refund |
| The PR-02m smoke lock | (see the PR-02m report) | FundsLocked, committed to a URL | PR-16b's refund, if it can be found |

---

## 3. The demo (about 3:00, my final cut)

| Time | Scene |
| --- | --- |
| 0:00 | **The market.** Three real workers: hardware reported by the machine, speed measured by the market ✓, and prices. Optional: a probation worker listed as "joining". |
| 0:20 | **The ask.** In Claude Code: "Make a poster of a lighthouse at dusk with Pekkah. Spend at most 3 cents." |
| 0:35 | **The agent shops.** Claude looks at the market and gets a quote. Nothing fits 3 cents: only worker A has a GPU, at 5 cents. Claude asks in one line, and I say "yes, through escrow". |
| 1:00 | **The UI follows live**, each step in order, with no scrolling by hand. The quote (A over budget; B and C without a GPU; A comes back as the counter-offer) → my agent's decision and its reason → 402 (escrow, seller A) → signed → verified → GPU busy → delivered and checked by the market (PNG, 1024×1024) → locked in escrow (tx) → result hash submitted (tx), with "unlocks at HH:MM". |
| 1:50 | **The result in Claude.** The image, and a receipt with the tx links and the unlock time. Cardanoscan shows the inline datum. |
| 2:15 | **The release.** A labelled time skip with the real elapsed time (about 33 minutes). The same run reopened with `?run=`, then "released to worker A" (tx), with the buyer's collateral back. |
| 2:35 | Optional, if the cut has room: 10 s of failover. I kill a job, nothing is charged, and the job is rerouted. |
| 2:50 | **Close.** "Any machine can join. Any agent can buy. Paid per job on Cardano." |

The close says "can join" because a new machine only sells once I've allowlisted it.

---

## 4. Rule changes (already in CLAUDE.md)

- **Rule 2.** Quotes are free, and my agent may ask me before buying, for example when nothing fits my budget. Once it buys, the payment flow (402 → sign → verify → settle) has no human step. An over-budget buy carries my agent's statement that I approved it. The market records it as that statement, never as proof. Spend caps stay on and are the hard limit.
- **Rule 4.** Say "locked in escrow" until an `escrow.released` event exists for that lock. Only then do the UI and the docs say "released to worker A". The buyer's collateral returns at release. Say "refunded to the buyer" only after an `escrow.refunded` event (PR-16b). Dispute stays unbuilt, and is always named as next.
- **Rule 8.** The Phase 2 priorities (section 0).
- **Payments safety.** Escrow runs tie up about 4 tADA of the buyer's collateral, plus the price, until the release about 31 minutes after the 402, so I keep them few. Seller A's script transactions are evaluated before they're signed. The MCP pays from buyer account 1.
- **Infrastructure.** I launch and terminate any AWS instance myself, and sessions never hold cloud credentials. Images publish only from `main`, through `publish.yml`. Open join runs only where `OPEN_WORKER_JOIN=1`.
- **Sessions.** Three sessions, with the ownership in section 5.

---

## 5. Sessions and ownership

| Session | Where | Owns (Phase 2) | Work |
| --- | --- | --- | --- |
| A | main checkout | `packages/*`, `apps/{market,agent,facilitator}`, `workloads/fractal`, root configs, `.github/workflows/ci.yml`, A's scripts (PLAN 8), `README.md`, `docs/WRITEUP.md`, `docs/RUNS.md` | PR-12, the spike, PR-13, PR-16, PR-17, PR-16b, PR-19 |
| B | worktree | `apps/web`, `apps/mcp` (with `apps/mcp/skill/`), `Dockerfile`, `.dockerignore`, `infra/`, `deploy/`, `workloads/flux`, `apps/worker/src/workloads/image.ts` plus its registration line, B's scripts (PLAN 8) | the stable MCP worktree, PR-14, PR-15, recording support |
| C | worktree | `apps/worker` (except B's two image files), `.github/workflows/publish.yml`, `.github/workflows/install-smoke.yml`, `install.sh`, `docs/WORKER.md` | PR-17w, PR-18 |

- Anything in another session's files, above all `packages/protocol`, goes under ASK. `pnpm-lock.yaml`, `docs/PLAN.md` and `docs/PLAN2.md` are shared, as in Phase 1.
- **Why three sessions:** the worker kit has its own files and sits off both critical paths. A keeps the chain work, B keeps the demo, and C builds the kit.
- If I run only two sessions, B takes C's PRs after PR-15.
- **Images:** C's `publish.yml` builds B's Dockerfile (`--target worker`) and `workloads/fractal` without changing them. If either needs a change, C asks.

---

## 6. PR specs

### Spike · Withdraw dry run · A · right after PR-12 is opened · 45 minutes at most · no PR

**Objective:** know tonight whether the Withdraw evaluates against the real validator.

- Work on a local branch for PR-16, from `origin/main`. It's local only: no deploy, no payment, and nothing signed or submitted.
- Build the Withdraw for the 18:24 escrow UTxO with the plumbing in `result-submit.ts`:
  - Seller A's Evolution client, over the facilitator's chain passthrough (run the facilitator locally)
  - `masumiValidator()`
  - the collateral reserve
- Call `build()`, which evaluates the script, and stop before `sign()`. Print the fee and the execution units.
- Follow 2.2 and 2.3:
  - **Redeemer:** `Data.constr(0n, [])`.
  - **Buyer output:** all of the escrow's lovelace, with the V3 OutputReference tag.
  - **Seller output:** the tUSDM, tagged too, with its min-ADA from Seller A's other UTxOs.
  - **Signer and validity:** `addSigner` for Seller A. Valid from `unlock_time` + 1 s (which covers slot rounding) to now + 180 s.
- Report to me in a few lines, then put the same under EVIDENCE in PR-16's report:
  - whether it evaluated
  - the fee
  - Seller A's pure-ADA UTxOs (amounts only)
- If it fails, spend 30 more minutes inside PR-16 at most, then take the fallback in section 8.

### PR-12 · Phase 2 spec (docs only) · A · now · gate Tue 21:15

- Commit `CLAUDE.md` and `docs/PLAN2.md` exactly as they are in the main checkout. I approve them by merging.
- Make these small edits in `docs/PLAN.md`:
  - Under the title, add: "Phase 2 (from Tuesday 6 October, evening) is specified in `docs/PLAN2.md`. For Phase 2 work, PLAN2 wins."
  - At the top of 12.1, add: "The final video follows PLAN2 section 3. This storyboard is the Phase 1 safety take."
  - At the end of 4.8's "Lock only" item, add: "(Phase 2 builds release: PLAN2 PR-16.)"
  - At the top of section 14, add: "PLAN2 section 11 replaces these limits after Phase 2."
- Add only those three files (`git add CLAUDE.md docs/PLAN.md docs/PLAN2.md`). `.claude/` is untracked and is never committed.
- Acceptance: `pnpm check` is green and the PR is open. Sessions B and C start once it's merged.

### PR-13 · Protocol and market events · A · after the spike · gate Wed 00:45 (else merged by 08:30)

It unblocks B's and C's merges, so it lands first.

`packages/protocol`:
- `run.started` accepts the scenario `"custom"` (free-form MCP and CLI runs) and an optional `client` of at most 40 characters (for example "Claude via MCP"). Keep the `Record<ScenarioName, …>` maps as they are: use `RunScenario = ScenarioName | "custom"` in `events.ts` and `RunLog`.
- `WorkerSnapshot` gains `selling: boolean` (false means probation) and `escrowSeller: boolean`.
- `HelloMsg.token` becomes optional. PR-17 adds the behaviour.
- **Hello string bounds.** `cpuModel` ≤ 80, `gpu.name` ≤ 64, `driver` ≤ 32, `version` ≤ 64, `schedule` ≤ 64, and `prices` ≤ 4 entries. The bounds must admit the three live workers' current hellos unchanged, so test them with the workers' recorded values.
- **New events**, with their label constants:
  - `escrow.released {lockTxHash, txHash, sellerAddress, buyerAddress, amountAtomic, asset, collateralReturnLovelace, explorerUrl}`
  - `escrow.refunded {lockTxHash, txHash, buyerAddress, amountAtomic, asset, collateralReturnLovelace, explorerUrl}`, which stays unused unless PR-16b lands
- `agent.decision` gains an optional `overBudget {budgetUsd, priceUsd}`. It's present only when my agent states that I approved a price above my budget.
- `job.completed` gains an optional `check {kind: "png", width, height}`.

`packages/matcher`:
- **Defense in depth:** `match()` considers only workers with `selling === true`, so it fails closed. A non-selling worker never appears in the offers, the counter-offer, the market price or the rejections.

`apps/market`:
- **Event sources become real.** `job.running`, `job.progress`, `job.completed` and `job.failed` come from `worker`. `payment.settled`, `escrow.locked`, `escrow.result_submitted`, `escrow.released` and `escrow.refunded` come from `chain`.
- **`/api/workers`** fills `selling` (true for every allowlisted worker today) and `escrowSeller` (the worker whose payTo is `SELLER_A_ADDRESS`, while Masumi is on). The quote route passes only selling workers to the matcher: the first layer of the defense.
- **The market checks every image result itself:** the PNG signature, and an IHDR size equal to the request. A mismatch fails the job, the handler answers 502, and nothing is charged. The check goes into `job.completed`.
- **`POST /api/demo/run` answers 409** while any run, hosted or MCP, has an event in the last 2 minutes and no terminal event. A click then can't cut into a recorded Claude run.

Acceptance:
- **Tests** for:
  - the schemas, the event sources and the PNG check
  - the bounds, against the live workers' hellos
  - the matcher: a non-selling worker that is cheapest, fastest and warm changes nothing in the quote
- **Deploy the market**, then run `scripts/demo-check.sh --runs 1`. Four paid runs pass, and the hosted scenarios are unchanged. If it fails before 01:00, redeploy the previous ref before sleeping.

### PR-14 · MCP shopping tools and skill · B · after the stable MCP worktree · merges after PR-13 · gate Wed 11:00

**`pekkah_quote`** is free and buys nothing.
- **Input:** an image (prompt, size, steps, seed) or a fractal (preset), a deadline, gpu/minVram, `budgetUsd`, and an optional `runId` to continue a task.
- **Output:**
  - the offers (offerId, worker, hardware as reported, price, estimate, seconds left, escrow available)
  - the counter-offer and the market price
  - every rejection, with its reason
  - a one-line hint: "fits the budget", or "nothing within $X: ask your human before paying $Y"
- The first quote of a task emits `run.started {scenario: "custom", client, request}` and `agent.balance`, and sends `X-Pekkah-Run-Id`. A task ends with `run.completed` or `run.failed`.
- The server remembers each task's budget with its quotes.

**`pekkah_buy {offerId, maxUsd, escrow?, overBudgetApproved?, reason}`**
- `maxUsd` is the ceiling my agent commits to, at most $0.10.
- It buys only offers it quoted itself, with the cached request, payTo and price.
- **The budget rule:** if the price is above the task's budget, it refuses unless `overBudgetApproved: true`. The refusal says: "This is above the $X budget your human gave. Ask them first." That makes the ask happen even if the model skips the skill.
- `agent.decision` records my agent's reason, plus `overBudget` for an over-budget buy. The text reads as my agent's statement ("my agent says Luis approved $0.05, above his $0.03 budget"), never as proof.
- `escrow` defaults to on when the offer's worker is the escrow seller.
- If the 120 s offer has expired, it re-quotes the same request and buys only from the same worker, at no more than `maxUsd` and under the same budget rule.
- It runs in the background through the existing `PurchaseBook`. The escrow expectation follows `apps/agent/src/run.ts`.

**`pekkah_result {runId}`** (`pekkah_get_image` stays as an alias). It waits up to 45 s and returns:
- the image, as an inline JPEG, and the saved PNG's path (`PEKKAH_OUTPUT_DIR`)
- the receipt
- the escrow lifecycle, read from `GET /api/runs/:runId/events`: locked, result submitted, unlock time, released

**`pekkah_market`** gains the escrow seller, the joining workers, and "reported" vs "measured" labels. `pekkah_generate_image` stays as a one-shot.

**The shopping policy, in two places.** A short version goes in the server's `instructions` (SDK 1.32 supports them, and Claude Code shows them to the model). The full version goes in `apps/mcp/skill/pekkah/SKILL.md`:
- look at the market, then get a quote
- when the human gave a budget and an offer fits it, buy without asking
- when nothing fits, ask in one line, naming the price and the worker
- when no budget was given, ask for one before buying (quoting first is fine)
- prefer escrow
- say "locked in escrow" until released
- give the tx links

**Config.** The MCP pays from buyer account 1 (`BUYER_ACCOUNT_INDEX=1` in the Claude config's `env`, which wins over the env file). A recorded Claude run then never shares a wallet with the run button.

**`apps/mcp/README.md`** covers:
- Claude Code setup (user scope)
- the skill install (`~/.claude/skills/pekkah`) and the Claude Desktop zip
- the tool permissions to pre-allow for recording

Names only, no values.

Acceptance (real chain, one paid run at a time):
1. "At most 3 cents" → Claude asks about A at $0.05 → I say yes → an escrow buy → the image, the lock tx and the result tx. The UI shows a run from "Claude via MCP", with the reason.
2. An explicit budget that fits ("at most 10 cents") → it buys without asking.
3. An over-budget `pekkah_buy` without `overBudgetApproved` is refused. This is a unit test, with no payment.
4. After PR-16, `pekkah_result` reports the release.

### PR-15 · Live-follow UI · B · fixtures now, live after PR-13 and PR-14 · gate Wed 13:00

- **The log follows.**
  - The log gets its own scroll box. It follows the newest row while the viewer is at the bottom. Scrolling up pauses it, and "Jump to latest" resumes.
  - `key={runId}`, `role="log"`, and a short entry animation with a reduced-motion guard.
  - The scroll logic lives in pure helpers, with node tests.
- **The current step.** `currentStep(run)` in `run.ts`, with `data-step` on the panels. While "Follow live" is on, the active panel is highlighted and scrolled into view. Follow pauses when the viewer scrolls, and comes back with a new run.
- **The live layout.** During a live run, the story goes first and widest, tuned for a 1280×800 recording.
- **The run header** comes from `run.started.data.request` and `client`, not the fixed scenario summary. When a run has several quotes, each shows its budget and outcome.
- **My agent's decision** shows its reason. An `overBudget` decision reads as my agent's statement: "my agent says I approved $0.05 (budget $0.03)".
- **`EscrowCard`**, in order:
  1. locked
  2. result hash submitted ("matches the delivered result" only when it equals `job.completed.sha256`)
  3. unlocks at HH:MM, as a countdown from the backend's `unlockTime`
  4. released to worker A (tx)
  5. refunded (tx), only if PR-16b lands

  `describe.ts` handles every event, with an exhaustive switch.
- **The market's checks.**
  - The PNG check appears as its own row.
  - A "Joining the network" group lists probation workers under the market's display id.
  - Hardware is labelled "reported by the machine", and speed "measured by the market".
- **Live detection and links.**
  - When the page opens mid-run, an unfinished run with an event in the last 15 minutes counts as live.
  - The run buttons are disabled under the same rule as the server's 409: an unfinished run with an event in the last 2 minutes.
  - `?run=<runId>` opens that run, live or finished, and keeps it on screen when newer runs start. Never cut it: the release scene depends on it.

Acceptance:
- On the hosted URL at 1280×800, during PR-14's Claude run, every step appears in order without touching the scroll. Scrolling up pauses it, and "Jump to latest" resumes it.
- `?run=` for that run, once it's released (about 33 minutes after its 402), shows the release.
- The production bundle contains no fixture data.

### PR-16 · Escrow release · A · after PR-13, starting from the spike's code · gate Wed 11:30

- **Deadlines.** `packages/payments/src/server.ts` passes `masumi.deadlines` (2.3), so the unlock comes about 31.5 minutes after the 402:
  - `submitResultAfterPayByMs`: 6 minutes
  - `unlockAfterPayByMs`: 21.5 minutes
  - `externalDisputeUnlockAfterPayByMs`: 37 minutes
- **`apps/market/src/escrow-release.ts`** (new, beside `result-submit.ts`). It reuses that file's Evolution client, `masumiValidator()`, collateral reserve and submit queue. It adds a dry-run mode (build and evaluate, no signature) for tests and the endpoint below. The Withdraw transaction:
  - **Input:** the escrow UTxO after SubmitResult. Its datum comes from `parseMasumiLockDatum`. Refuse unless the state is ResultSubmitted, the seller is Seller A, and now is past `unlock_time`.
  - **Redeemer:** `Data.constr(0n, [])`.
  - **Buyer output:** to `buyer_return_address ?? buyer`, rebuilt exactly, with its stake key. It carries all of the escrow's lovelace (at least `collateral_return_lovelace`) and the inline datum `Constr 0 [lock tx hash, output index]`.
  - **Seller output:** the tUSDM to Seller A, with the same tag. Its min-ADA comes from Seller A's UTxOs, never from the collateral reserve.
  - **Signer and validity:** `addSigner(seller)`. Valid from `unlock_time` + 1 s to now + 180 s.
  - **Safety:** `build()` evaluates the script before anything is signed.
- **`apps/market/src/release-scheduler.ts`** (new).
  - Pending releases come from live `escrow.result_submitted` events and, at startup, from RunStore's saved runs.
  - Each fires at unlock + 60 s, checks that the escrow UTxO is still unspent, and retries with backoff, with polls at least 5 s apart.
  - It confirms with the poll in `result-publish.ts`, then emits `escrow.released` with the run's `runId` and `jobId`.
- **`POST /api/escrow/release {lockTxHash}`**, with Bearer `DEMO_TOKEN` only. It covers locks the scheduler doesn't know. It's harmless: it only ever returns the buyer's collateral and pays the price to Seller A, and only after the unlock.
- **Receipts.** My agent's escrow receipt (`apps/agent/src/escrow.ts`) states the unlock time, and that worker A collects then. The lock label (`MASUMI_LOCK_LABEL`) and its released counterpart follow rule 4.
- **Before deploying**, check that Seller A holds the collateral reserve (a pure-ADA UTxO of at least 2 tADA), plus another pure-ADA UTxO of at least 3 tADA. If it doesn't, ask me to fund it, and give me the address.

Acceptance (real chain):
1. After the deploy, the 18:24 lock (`ae0a2d86…`) is released within 2 minutes. Cardanoscan shows the tUSDM at Seller A and the collateral back at the buyer, and `escrow.released` appears in run `01M48BXBX…`.
2. One new `gpu-image-escrow` run is locked, its result is submitted, and it's released a minute or two after its unlock (about 33 minutes after its 402), with no human step. The release tx goes into that run's evidence block in `docs/RUNS.md`.
3. `scripts/demo-check.sh --runs 1` passes.

### PR-17 · Open join on probation (market side) · A · after PR-13, during PR-16's waits · merges after PR-16 · gate Wed 13:00

- **`OPEN_WORKER_JOIN=1`** turns open join on. It's off by default, and in tests unless set. I add it to the hosted market's env before this deploy.
- **Probation.** A hello without a token, or with an id outside `WORKER_TOKENS`, joins on probation:
  - It gets `selling: false`, and the quote route and the matcher ignore it (PR-13's two layers).
  - It's calibrated like any worker: the fractal answer is checked, and image is timed when warm. It never gets a paid job.
  - It's removed from the registry on disconnect.
- **Allowlisted ids.** An allowlisted id without its valid token is refused (`unauthorized`). A known id with its token still sells, exactly as today.
- **A market-safe identity.**
  - The market gives each probation worker a display id: `joining-` plus 6 random hex characters per connection.
  - The UI and `/api/workers` show that id, never the `name` it sent.
  - Its hardware strings are trimmed to the bounds, and stripped to letters, digits, spaces and `()+-./@_`.
- **Limits.**
  - At most 10 probation workers, and at most 2 per client IP.
  - The IP comes from `X-Forwarded-For` as Caddy sets it, because the market's port isn't public. Check that Caddy overwrites any value a client sends.
  - A hello must arrive within 10 s.
  - Large messages before the hello stay a known limit, bounded by the socket cap.

Acceptance:
- **Tests:** probation join, `selling` staying false, the display id, the sanitization, the limits, allowlisted ids protected, removal on disconnect, and a refusal when the flag is off.
- **Deploy** with `OPEN_WORKER_JOIN=1`. A local probation worker (a container on my Mac, pointed at the hosted market) joins, calibrates ✓, and is listed with `selling: false` under its display id.
- **No effect on the market:** the three public scenario quotes are byte-identical before it connects and while it's connected, and `demo-check --runs 1` passes.

### PR-17w · Worker app, `probe` and published images · C · now (local) · merges after PR-13 · gate Wed 11:00

**Worker** (`apps/worker`):
- `WORKER_TOKEN` becomes optional (after PR-13).
- On `unauthorized` or `invalid_hello`, the worker exits with a clear message instead of reconnecting forever.
- Hardware is detected again on every connect.
- Hello strings are trimmed to PR-13's bounds before sending.

**`probe`** (`tsx src/index.ts probe`, and in the image):
- It prints the machine card: CPU, cores, RAM, GPU, Docker version, and whether the NVIDIA runtime is there.
- It runs the local benchmark: the checked calibration challenge (sha256 against `CALIB_SHA256`) with the fractal image, and the hd-fast timing.
- With a GPU, it runs a `--gpus all` container check.
- It exits non-zero if a check fails.
- In the image, it needs the Docker socket mounted.

**`.github/workflows/publish.yml`** runs on every push to `main`:
- It publishes `ghcr.io/lain-21/pekkah-worker` (the Dockerfile's `worker` target) and `ghcr.io/lain-21/pekkah-fractal` (`workloads/fractal`).
- linux/amd64 only.
- Tags `sha-<short>` and `latest`, with the OCI source label set in the workflow.
- `permissions: packages: write` for this workflow only. `ci.yml` keeps `contents: read`.

Acceptance:
- CI publishes both images. I make both packages public, and an anonymous `docker pull` works.
- `probe` runs from the published image on worker A's host (`docker run --rm` with the socket, without touching the live worker container), between paid runs. It shows the RTX 4000 Ada and passes the GPU container check.
- The live workers keep running unchanged.

### PR-18 · Installer, WORKER.md and the install smoke test · C · after PR-17w · acceptance needs PR-17 deployed · gate Wed 15:30

**`install.sh`** at the repo root:

```
curl -fsSL https://raw.githubusercontent.com/LAIN-21/pekkah-origins/main/install.sh | sudo sh -s -- --payout addr_test1…
```

1. Check for Linux and Docker. If Docker is missing, print the get.docker.com command, and install nothing silently.
2. Detect the GPU and the NVIDIA container runtime.
3. Pull both images and run `probe`.
4. Write `/etc/pekkah/worker.env` (mode 600) with:
   - a `p-<6 hex>` id
   - CPU and memory sized from the machine
   - the market URL: the hosted one by default, or `--market` to override it
   - the payout address
   - the published fractal image
5. Start `pekkah-worker` with `--restart unless-stopped`, the Docker socket and `/var/lib/pekkah`.
6. Wait until `/api/workers` lists it, then print the page link and its display id.

`--token` with `--id` (an allowlisted id) sells. `--uninstall` removes the container, the env file, the data directory and the images.

**`docs/WORKER.md`** covers:
- what the worker does
- the trust model: the worker container holds the Docker socket, so it's root on the host; the jobs are the sandboxed part
- what the market measures, and what the machine reports
- probation, and how a worker starts selling: I allowlist its id
- the GPU path, as manual FLUX steps

**`.github/workflows/install-smoke.yml`** runs on `workflow_dispatch` only, on a fresh `ubuntu-latest` runner, against the hosted market:
1. Run the one-liner, with a payout address I give as an input.
2. Expect a listing as joining, calibrated ✓, with `selling: false`.
3. Check that the three public scenario quotes are unchanged.
4. Run `--uninstall`, and expect the worker to be gone from `/api/workers`.

Acceptance:
- A green install-smoke run, with its link in the report.
- `--uninstall` leaves nothing behind.
- Optional: the GPU path on an AWS G instance that I launch (9.6).

### PR-16b · Refund of no-result locks (first bonus) · A · only once the release, the MCP flow, the live UI, the worker kit and a safety take are secured · never started after 15:00

- **`pnpm agent refund <lockTxHash>#<index>`.** A WithdrawRefund (redeemer 3), signed by the buyer, run from my Mac with my local env (the buyer may call Blockfrost).
  - Valid from `submit_result_time` + 1 s to now + 180 s.
  - Everything goes back to the buyer's address, tagged like a release.
  - The collateral is a pure-ADA buyer UTxO.
  - It's evaluated before it's signed.
- It posts `escrow.refunded` to the lock's run through `/api/agent-events`.
- **Acceptance:** Cardanoscan shows the 16:34 lock (`92787101…`) back at the buyer (the tUSDM plus the collateral), and `escrow.refunded` appears in run `01M485KG1X…`. Then the same for the PR-02m smoke lock, if it can be found.

### PR-19 · Release v0.2.0 (docs) · A · after the freeze · gate Wed 19:00

- **README:**
  - the one-line worker install, linking the green install-smoke run
  - the Claude/MCP flow
  - lock → result → release, with real tx hashes
- **Honest limits:** section 11.
- `docs/WRITEUP.md` and `docs/RUNS.md` gain the result, release (and refund) txs.
- `pnpm secrets:scan`, the fresh-clone check, and the `v0.2.0` tag.

---

## 7. Timeline and gates (SGT)

| Work | Session | Starts when | Merge needs | Gate (deadline) |
| --- | --- | --- | --- | --- |
| PR-12 | A | now | | Tue 21:15 |
| Spike | A | PR-12 is opened | (no PR) | Tue 22:00 |
| PR-13 | A | the spike is done | | Wed 00:45, else 08:30 |
| Stable MCP worktree | B | PR-12 is merged | | Tue 22:00 |
| PR-14 | B | the stable worktree | PR-13 | Wed 11:00 |
| PR-15 | B | PR-12 is merged (fixtures) | PR-13; live with PR-14 | Wed 13:00 |
| PR-17w | C | PR-12 is merged | PR-13 | Wed 11:00 |
| PR-16 | A | PR-13 (the spike's code) | PR-13 | Wed 11:30 |
| PR-17 | A | PR-13, in PR-16's waits | PR-16 | Wed 13:00 |
| Worker-kit go/no-go | me | | | Wed 13:00 |
| Rehearsal 1 + safety take 1 | me + B | PR-14, PR-15 and PR-16 merged | | Wed 14:00 |
| PR-18 | C | PR-17w | PR-17 deployed, images public | Wed 15:30 |
| PR-16b (bonus) | A | everything above secured | | starts by 15:00 |
| Three rehearsals | me + B | | | Wed 16:00 |
| Freeze | | | | Wed 17:00 |
| PR-19 | A | the freeze | | Wed 19:00 |

| When | Me | Session A | Session B | Session C |
| --- | --- | --- | --- | --- |
| Tue 20:45–21:30 | Approve these docs; record safety take 0; fund buyer account 1 | PR-12, then the spike | (starts after PR-12) | (starts after PR-12) |
| 21:30–01:00 | Merge as reports come | The spike, then PR-13 (deploy and demo-check before 01:00, or at 08:00) | The stable MCP worktree, PR-14 locally, PR-15 on fixtures | PR-17w locally (probe, exit, re-detect, publish.yml) |
| 01:00–08:00 | Sleep. No deploys | | | |
| Wed 08:00–11:30 | Merge | PR-16, its deploy and both releases; PR-17 during the waits | Merge PR-14, then PR-14's acceptance with me | Merge PR-17w; probe on A; I make the packages public |
| 11:30–13:00 | Worker-kit go/no-go at 13:00 | PR-17's deploy (`OPEN_WORKER_JOIN=1`) | PR-15 live | PR-18 |
| 13:00–16:00 | Rehearsal 1 and safety take 1, then two more rehearsals | PR-16b if allowed | Recording support | PR-18's acceptance (install-smoke) |
| 16:00–17:00 | Fixes from the last rehearsal | Fixes | Fixes | Fixes |
| 17:00–19:00 | | PR-19 | Bug fixes only | Bug fixes only |
| 19:00–20:30 | Record and cut the video | | | |
| 20:30–22:00 | The deck (video embedded) and the write-up | | | |
| 22:00–23:00 | Submit: the main track, then the Cardano track | | | |

The deliverables and the submission checklist stay as in PLAN 1 and 12.2. The Cardano track's evidence now also has the result and release txs.

---

## 8. Cut order and fallbacks

Cut in this order when behind:
1. Already cut: arm64 images, and `gpus[]`/`offered`.
2. The optional AWS GPU check.
3. Multi-quote cards in the UI.
4. The "Joining the network" UI group. The API still lists probation workers, and the README links the install-smoke run.
5. PR-16b.
6. The market's PNG check.
7. Open join itself. `install.sh` ships with `--token` only, and open join goes back to "next".

Never cut:
- the hosted scenarios staying green, and the Masumi minimum's evidence
- the release (unless the validator path fails)
- the MCP budget flow
- the following log, and `?run=`
- the safety takes
- the video, deck, README and write-up

| Risk | Trigger | Fallback |
| --- | --- | --- |
| The Withdraw won't evaluate | The spike fails, plus 30 minutes in PR-16 | Keep the lock plus result hash, with today's wording; release is "next". Scene 6 shows the escrow card with "unlocks at" and the result-hash tx |
| The shorter deadlines are refused | The first escrow run after PR-16 fails at the 402 or verify | The default deadlines (unlock about 45 minutes after the 402). The video's label gives the real elapsed time |
| Claude doesn't follow the flow | Rehearsal 1 | Tighten the server instructions and tool descriptions; the over-budget refusal already forces the ask. Record from the best rehearsal take |
| The image doesn't show in Claude's window | Rehearsal 1 | Scene 5 shows the saved PNG, or the UI's result panel |
| Open join isn't merged | 13:00 | `install.sh --token` only. The README says new workers join by allowlist |
| The GHCR packages can't go public | The first publish | WORKER.md builds the images locally, and install-smoke builds them on the runner |
| The scheduler misses a lock | A lock 5 minutes past unlock, without a release | `POST /api/escrow/release` with `DEMO_TOKEN` |
| The GPU droplet is lost | `pekkah` dies | The CPU-only demo with `fractal-escrow`. Or I launch an AWS G instance and run FLUX by hand (WORKER.md's GPU path). Its address isn't Seller A, so escrow stays on `fractal-escrow` |
| Usage limits | A session is throttled | C pauses first, then B. A always continues |

---

## 9. Operations

### 9.1 The stable MCP worktree (B, first)

My Claude Desktop and Claude Code start the MCP from a checkout, so branch work there would change what my Claude runs. B adds a detached worktree at `origin/main` for the MCP:

```bash
git worktree add --detach ~/Developer/pekkah-mcp origin/main
pnpm --dir ~/Developer/pekkah-mcp install
```

- B gives me the exact config change for Claude Desktop and Claude Code: the paths, plus `BUYER_ACCOUNT_INDEX=1` and `PEKKAH_OUTPUT_DIR` in `env`.
- B updates the worktree only after merges: fetch, `git -C ~/Developer/pekkah-mcp checkout --detach origin/main`, then `pnpm install`.
- The Phase 1 B worktree stays until I've switched my config. Don't archive the Phase 1 B session before then, and never run `git worktree prune`.

### 9.2 Wallets (amounts only, never keys)

- **Buyer account 0** (the hosted agent): at least 30 free tADA before rehearsals. Each escrow run holds about 4 tADA until its release, and each default payment moves about 1.2 tADA of min-ADA to the worker.
- **Buyer account 1** (the MCP): I fund it tonight with tADA from the faucet and a few tUSDM. B tells me its address, which the MCP logs at start.
- **Seller A:** the collateral reserve (a pure-ADA UTxO of at least 2 tADA), plus another pure-ADA UTxO of at least 3 tADA. A checks this in the spike and asks if it's short.

### 9.3 Paid runs

- One at a time, across all sessions. Before one, check that `/api/runs/latest` isn't live.
- Print the Cardanoscan link for each.
- A release or a result submission is Seller A's transaction, not a payment, so escrow waits don't block other runs.
- No paid runs while I'm recording, except the recorded one.

### 9.4 Env names (the values live only in `~/.pekkah`)

- **Market:** `OPEN_WORKER_JOIN`. I set it to 1 before PR-17's deploy.
- **MCP** (in the Claude config's `env`): `BUYER_ACCOUNT_INDEX=1` and `PEKKAH_OUTPUT_DIR`.
- Nothing else is new.

### 9.5 Deploys

- Only through `scripts/deploy.sh`.
- `demo-check --runs 1` after every market deploy. If it fails, redeploy the previous ref.
- Never while I'm recording, and never between 01:00 and 08:00.
- The release scheduler isn't a deploy, and it keeps running while I record.

### 9.6 The install host

The install test runs on a fresh GitHub-hosted Ubuntu runner (install-smoke). That's the honest clean-machine test, and the run is public evidence.

Optionally, if I want the GPU path on a fresh machine, or a real "joining" GPU in the video:
- I launch it myself in us-east-1, where my G and VT limit is 8 vCPUs.
- **Type:** `g4dn.xlarge` (one T4 with 16 GB, 4 vCPU), about $0.53 an hour on demand.
- **AMI:** "Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)". It includes the NVIDIA driver, Docker and the NVIDIA Container Toolkit.
- I connect with EC2 Instance Connect in the browser, paste the one-liner, check the page, then run `--uninstall`.
- I terminate the instance, not just stop it, as soon as I'm done.
- Sessions never hold AWS credentials and never create instances.

---

## 10. Recording

- **Safety take 0, tonight, before PR-13's deploy:** the Phase 1 flow (PLAN 12.1) from the hosted UI. It's my fallback video.
- **Safety take 1:** right after the first successful Phase 2 rehearsal.
- **The final take, 19:00–20:30:** I start the recorded Claude run by 19:00, so its release lands by about 19:35. Scene 6 is that run, reopened with `?run=<runId>`.
- **Setup:**
  - Claude Code with the Pekkah tools pre-allowed, so no permission dialog appears. My "yes" in the chat is the only approval on screen.
  - The skill installed, and the MCP on buyer account 1.
  - The UI at 1280×800, beside Claude.
  - I tell every session "recording", and later "done recording".
- **In rehearsal 1,** check that the image shows in the Claude window. If it doesn't, scene 5 uses the saved PNG or the UI's result panel.
- Never show env files, or a terminal with secrets. Label every time skip and sped-up part.
- Say "locked in escrow" until the release appears on screen.

---

## 11. Honest limits after Phase 2 (for the README and write-up in PR-19)

- Preprod only, paid in test tokens.
- **Probation.** New workers join on probation: listed and measured, never sold, until I allowlist them. Open join is on only where `OPEN_WORKER_JOIN=1` (the hosted demo).
- **Reported versus measured.** Hardware is reported by the machine; speed is measured by the market.
  - CPU work is answer-checked at calibration.
  - GPU work is timed. The market checks that each image is a PNG of the requested size, not what it shows.
- **Over-budget buys.** An over-budget buy rests on my agent's statement that I approved it. The wallet's spend caps are the hard limit.
- **Seller A's key.** The market holds it: it signs the escrow terms, the result hash and the release. Next: the worker signs over its WebSocket.
- **Escrow coverage.** Release is built; it comes after the unlock, about 31 minutes after the 402. Refund of no-result locks: [built in PR-16b | next]. Dispute is next.
- **Default payments.** Between verification and settlement, the market holds the buyer's signed transaction. Escrow removes that trust.
- **One market instance** with in-memory state. A restart drops open offers, and agents re-quote.
- **Min-ADA.** Every token payment carries about 1.2 tADA of min-ADA. Next: prepaid deposits with batched settlement.

---

## 12. Kickoff

1. Close the Phase 1 sessions, or leave them idle. Don't archive the Phase 1 Session B yet: my MCP runs from its worktree until 9.1 is done.
2. **Session A:** New session → Local → folder `~/Developer/pekkah-origins` → mode Auto. Type `/cardano-context`, then paste kickoff A.
3. While A does PR-12: record safety take 0, and fund buyer account 1.
4. When PR-12 is merged:
   - **Session B:** New session → Local → the same folder → worktree on → mode Auto. Paste kickoff B.
   - **Session C:** the same, with kickoff C.

Kickoff A:

> You are Session A on Pekkah, Phase 2. Read CLAUDE.md, docs/PLAN.md and docs/PLAN2.md completely before doing anything. CLAUDE.md and docs/PLAN2.md are new in this checkout and not committed yet. Your track is A: PR-12 (commit the Phase 2 docs), the Withdraw dry-run spike (45 minutes at most, no PR, nothing signed), PR-13, PR-16, PR-17, the bonus PR-16b only when PLAN2 allows it, and PR-19 after the freeze. Start PR-12 now on branch pr-12-phase2-spec from origin/main. Build exactly each PR's scope, run its acceptance checks yourself, open the PR with gh, and send the report format from CLAUDE.md. While I review, start your next PR locally as CLAUDE.md describes. Gates are deadlines, not start times: whenever you finish early, keep going.

Kickoff B:

> You are Session B on Pekkah, Phase 2, working in this worktree. Run git fetch origin && git checkout --detach origin/main, then read CLAUDE.md, docs/PLAN.md and docs/PLAN2.md completely before doing anything. Your track is B: first the stable MCP worktree (PLAN2 9.1), with the exact config change for me, then PR-14, then PR-15, then recording support. Don't change apps/mcp until the stable worktree is in place and I've switched my config. PR-14 and PR-15 merge only after PR-13; until then, build them locally (PR-15 on fixtures). Touch only the files Session B owns. When the acceptance checks pass, open the PR with gh and send the report format from CLAUDE.md. While I review, start your next PR locally as CLAUDE.md describes. Gates are deadlines, not start times: whenever you finish early, keep going.

Kickoff C:

> You are Session C on Pekkah, Phase 2, working in this worktree: you build the worker kit. Run git fetch origin && git checkout --detach origin/main, then read CLAUDE.md, docs/PLAN.md and docs/PLAN2.md completely before doing anything. Your track is C: PR-17w (the worker app, probe and published images), then PR-18 (install.sh, docs/WORKER.md and the install-smoke workflow). Touch only the files Session C owns, and ask under ASK for anything in packages/protocol, apps/market or the Dockerfile. Build first whatever needs no other PR: the optional token waits for PR-13, and PR-18's acceptance waits for PR-17's deploy. You never run paid jobs, and you never deploy. When the acceptance checks pass, open the PR with gh and send the report format from CLAUDE.md. While I review, start your next PR locally as CLAUDE.md describes. Gates are deadlines, not start times: whenever you finish early, keep going.

---

## 13. Thursday

- No deploys after I submit.
- Wednesday night, before sleeping: check the buyer's and Seller A's balances, and check that every escrow run of the day has released.
- Thursday 09:00: run `scripts/demo-check.sh --runs 1`.
- The Top 5 call is at 12:00, and I attend it. If I'm not selected: teardown (PLAN 13.4). If I am: everything stays up until 17:00.
