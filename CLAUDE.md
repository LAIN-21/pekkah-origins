# CLAUDE.md: Pekkah

Pekkah is a market where idle machines sell compute per job to AI agents, paid with x402 on Cardano preprod. I'm Luis, the solo builder. You build it with me in parallel sessions during the TOKEN2049 Origins Hackathon (Tue 6 Oct 12:00 to Wed 7 Oct 23:59 SGT).

**At the start of every session, read `docs/PLAN.md` and `docs/PLAN2.md` in full.** PLAN.md is the Phase 1 spec and PLAN2.md is the Phase 2 spec; for Phase 2 work, PLAN2 wins where they differ. This file is the rules. When a spec and this file conflict, this file wins; tell me about the conflict.

## Phases

- Phase 1 is merged and live: PR-01 to PR-11, PR-10b and B1. Its hosted scenarios and its Masumi evidence must keep working through Phase 2.
- Phase 2 (PLAN2) runs until the Wed 17:00 freeze: escrow release, my agent shopping in Claude through the MCP with a live-follow UI, and the worker kit.

## Sessions and ownership (Phase 2)

- **Session A** (main checkout): PR-12, the Withdraw spike, PR-13, PR-16, PR-17, the bonus PR-16b only when PLAN2 allows it, and PR-19 after the freeze. Owns `packages/*`, `apps/{facilitator,market,agent}`, `workloads/fractal`, root configs, `.github/workflows/ci.yml`, the scripts listed for A in PLAN section 8, `README.md`, `docs/WRITEUP.md` and `docs/RUNS.md`.
- **Session B** (worktree): the stable MCP worktree (PLAN2 9.1), PR-14, PR-15, then recording support. Owns `apps/web`, `apps/mcp` (with `apps/mcp/skill/`), `Dockerfile`, `.dockerignore`, `infra/`, `deploy/`, `workloads/flux`, `apps/worker/src/workloads/image.ts` plus its registration line in `workloads/index.ts`, and the scripts listed for B in PLAN section 8.
- **Session C** (worktree): PR-17w and PR-18, the worker kit. Owns `apps/worker` (except Session B's two image files), `.github/workflows/publish.yml`, `.github/workflows/install-smoke.yml`, `install.sh` and `docs/WORKER.md`.
- If I run only two sessions, Session B takes Session C's PRs after PR-15.
- Need a change in another session's files, above all `packages/protocol`? Ask under ASK in your report. Don't edit them. Three files are shared: `pnpm-lock.yaml`, which each session commits when it adds dependencies to its own packages (conflict rule in the workflow below), and `docs/PLAN.md` and `docs/PLAN2.md`, which any session may correct in a PR, calling the change out.

## Non-negotiables

1. Never fake a worker, transaction, execution, event, timing or result. No mock data in production code paths. Fixtures live only in tests and in the UI's dev mode (`import.meta.env.DEV` plus `?fixture=1`), never in the production bundle.
2. No human approval inside the payment flow. Quotes are free, and my agent may ask me before it buys, for example when nothing fits the budget I gave. Once it buys, the flow (402 → sign → verify → settle) has no human step. When it buys above my budget, it states that I approved; the market and the UI record that as my agent's statement, never as proof. Spend caps stay on at all times and are the hard limit.
3. The UI shows only states the backend emitted, in the order they happened.
4. The worker that is paid is the worker that ran the job: payTo is that worker's `PAYOUT_ADDRESS`. For escrow jobs, payTo is the Masumi escrow address and the worker that ran the job is the seller. Say "locked in escrow" for a lock until an `escrow.released` event exists for it; only then may the UI and the docs say "released to worker A". The buyer's collateral returns at release. Say "refunded to the buyer" only after an `escrow.refunded` event (PR-16b). Dispute is not built: always name it as next.
5. Settle only after delivery. The paid handler answers 400 or above on any failure, so x402 never settles.
6. `packages/protocol` is canonical. Only Session A changes it, and the PR calls the change out.
7. Cut scope before weakening the end-to-end flow. At a missed gate, take the fallback in PLAN2 section 8.
8. Priorities (PLAN2 section 0): keep what's live working → the Phase 2 core (release, the MCP budget flow, the live-follow UI, the worker kit) → a safe recording → bonuses (PR-16b first).
   - The Masumi minimum (PLAN 4.9) stays met: its evidence and the `gpu-image-escrow` scenario keep working.
   - Paid runs never overlap, across all sessions, and nothing is redeployed during a run.
   - Feature freeze Wed 17:00. After it: PR-19, bug fixes, the video, the deck and the submission.
9. The hackathon allows public libraries, frameworks, APIs and tooling. Everything else is written during the event. The MIT Express starter and the Apache-2.0 `@x402` packages may be used and adapted (keep their notices). `cardano-foundation/x402-cardano-demo` has no licence: read it for patterns, never copy it.

## Secrets

- Never print, `cat`, echo, log, commit or paste the values of: `BUYER_MNEMONIC`, `SELLER_A_MNEMONIC`, `BLOCKFROST_PROJECT_ID`, `HF_TOKEN`, `DIGITALOCEAN_TOKEN`, `WORKER_TOKEN*`, `WORKER_TOKENS`, `AGENT_TOKEN`, `DEMO_TOKEN`.
- Refer to them by name only. Example env files list names, never values. Secrets and Terraform state live outside the repo in `~/.pekkah/` (PLAN 5.5); I fill the values myself.
- Never open, read, `cat`, `grep` or `source` anything in `~/.pekkah/` except through the scripts built for it. Don't run commands whose output can include secret values (`env`, `printenv`, `set`, `docker inspect` on a service container's config, `terraform output` of sensitive values). Use `scripts/check-env.sh`, which prints names with `set` or `MISSING`.
- Logs redact any key matching `/mnemonic|token|secret|project_?id|authorization/i`.
- Before every push: `pnpm secrets:scan` (gitleaks through Docker) must be clean.

## Infrastructure safety

- The GPU droplet named `pekkah` (159.203.0.34, RTX 4000 Ada; not to be confused with the repo or my old private repo `LAIN-21/pekkah`) is irreplaceable this week. Never delete, resize, rebuild, power off or snapshot it, and never create another GPU droplet. Terraform only reads it (a data source) and attaches the worker firewall to it.
- Ask me before: `terraform apply`, `terraform destroy`, any `doctl … create|delete|resize`, firewall changes outside Terraform, rebooting a host.
- No new cloud services, accounts, domains or paid plans without asking. I launch and terminate any AWS instance myself: sessions never hold AWS credentials and never create cloud resources.
- Container images publish only from `main`, through `.github/workflows/publish.yml`. I set their visibility.
- Open join (probation workers) runs only where `OPEN_WORKER_JOIN=1`. I set it on the hosted market.
- Don't deploy while I'm recording. I'll say "recording" and "done recording". No deploys between 01:00 and 08:00 either.
- Deploy only through `scripts/deploy.sh`, which takes a per-host lock so sessions never overwrite each other. Never use `--force` on a ref another session deployed without asking me. Every report says which ref is deployed where.
- Dev routes (`/api/dev/*`) stay behind `PEKKAH_DEV_ROUTES=1` plus `DEMO_TOKEN`, and the flag stays off in production (PR-11).

## Payments safety

- Network `cardano:preprod` only. Asset `PEKKAH_ASSET` (tUSDM). Spend caps on at all times: $0.10 per payment, $0.20 per run, $5 per day for the hosted agent; the MCP keeps its own caps, at most $0.10 per payment. Never pass `spendControls: false`.
- Paid routes are registered directly on `app`, never in a sub-router (PLAN 4.1, fact 11), and a test proves an unpaid request gets 402.
- One payment in flight per buyer wallet, and one paid run at a time across all sessions. After a settled payment, wait until Blockfrost shows the tx before the next one. The hosted agent pays from buyer account 0 and the MCP from account 1.
- Test payments are real transactions: keep smoke runs few, and print the Cardanoscan link for each. Every escrow run ties up about 4 tADA of the buyer's collateral, plus the price, until its release about 31 minutes after the 402: keep escrow runs few, and check the buyer's tADA before rehearsals.
- Seller A's script transactions (SubmitResult, Withdraw) are built by the market, one at a time, and evaluated before they are signed. The buyer's refund (PR-16b) is built by my agent and evaluated the same way.
- Only the facilitator and the buyer call Blockfrost, with polls at least 5 s apart. The market reaches the chain only through the facilitator.

## Job sandbox

- Workers run only the whitelisted workloads (`fractal`, `image`) and the configured images. Params are validated with zod. Docker arguments are an array, never a shell string.
- Job containers always run with `--network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory --cpus --user 1000:1000`, an output bind mount only, and a kill at the deadline + 10 s. Full command in PLAN 7.3.
- Probation workers never get paid jobs, only calibration.

## Workflow for every PR

Time rules: gates in PLAN2 (and PLAN for Phase 1) are deadlines, never start times. Start each PR the moment its dependencies are merged (PLAN2 section 7), whatever the clock says, and never wait for a clock time. Timeboxes are maximums: stop as soon as it works. No padding: when the acceptance passes, the PR is done; leftover time goes to the next PR, never to extra polish or scope. If your next PR is blocked by another session, start the next unblocked one (or a local-only part of the blocked one) and say so in your report.

1. `git fetch origin && git checkout -b pr-NN-slug origin/main`.
2. Build exactly the PR's scope from PLAN2 section 6 (Phase 1: PLAN section 9). Small commits. Tests for logic.
3. `pnpm check` green → `git fetch && git rebase origin/main` → push → `gh pr create` (title `PR-NN: <name>`). On a `pnpm-lock.yaml` conflict, take origin/main's lockfile, run `pnpm install`, and commit the result; never hand-merge the lockfile.
4. Run the PR's acceptance checks yourself: real commands, real chain, real hosts. Collect the evidence.
5. Send the report below, then don't sit idle while I review. Start your next PR on a branch stacked on this one (`git checkout -b pr-MM-slug` from the current branch). Until I merge, it's local work only: code and tests, no deploys, no payments, no PR. If I ask for changes, switch back, fix, update the report, and continue.
6. When I reply "merge":
   - `gh pr merge <number> --squash`, without `--delete-branch` (it tries to switch to `main` locally).
   - `git push origin --delete pr-NN-slug` and `git fetch origin`.
   - If you stacked work, move it onto main with `git rebase --onto origin/main pr-NN-slug pr-MM-slug` and carry on. Otherwise start the next PR from `origin/main` (step 1).
   - Then delete the old local branch.
   - Never check out `main` itself: the sessions share one repo through worktrees, and a branch can be checked out in only one of them.

Report format:

```
PR-NN ready: <name> (<PR URL>)
WHAT CHANGED: 3 to 6 bullets
EVIDENCE: each acceptance command I ran, then the key output (tx links, timings, hashes)
YOUR CHECK: at most 3 things only Luis can confirm (open this link, look at this image)
RISKS / CUTS: what I skipped, what's flaky, which fallback I took
ASK: what I need from you or the other session (or "none")
NEXT: PR-MM and its first step
Reply "merge" to merge.
```

If you're blocked for more than 30 minutes on one problem, stop and report it with the fallback you propose.

## Tech conventions

- Node 22, pnpm workspaces, TypeScript strict, ESM (`NodeNext`). Node apps run with tsx (no build step). Biome for lint and format. Vitest. zod 3. Express 4.21. ws 8. pino.
- `@x402/core`, `@x402/express`, `@x402/fetch` and `@x402/cardano` pinned to exactly `2.26.0`, and `@evolution-sdk/evolution` to `0.5.14`. Don't bump them.
- PLAN 4.1 lists the library APIs I verified in the source. Trust it over memory. For anything not listed, read `node_modules/@x402/*/dist` before writing code against it. Use Cardano Dev Skills (`/cardano-context`) for Cardano questions.
- PLAN2 section 2 lists the Masumi validator and `@x402/cardano` facts I checked against the source on Tue 6 Oct. Trust it over memory too.
- Express: enable `case sensitive routing` and `strict routing`; mount the payment middleware at route level; every async handler wraps its body in try/catch and always ends the response.
- Config only through env (names in PLAN 5.5). Each app validates only the env it uses, with zod, at startup, and exits listing the missing names. Empty strings count as unset (compose passes `""` for an unset `${VAR}`).
- Money is integer atomic units (strings or bigint) internally. USD is for display only.

## Writing

- README, docs, UI copy, commit messages and PR text: first person singular ("I"), never "we". Plain words, short sentences, no hype.
- An over-budget approval is my agent's statement. Never describe it as proof that I approved.
- Code comments only where the reason isn't obvious.
