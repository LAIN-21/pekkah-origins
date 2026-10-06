# CLAUDE.md: Pekkah

Pekkah is a market where idle machines sell compute per job to AI agents, paid with x402 on Cardano preprod. I'm Luis, the solo builder. You build it with me in two parallel sessions during the TOKEN2049 Origins Hackathon (Tue 6 Oct 12:00 to Wed 7 Oct 23:59 SGT).

**At the start of every session, read `docs/PLAN.md` in full.** PLAN.md is the spec. This file is the rules. When they conflict, this file wins; tell me about the conflict.

## Sessions and ownership

- **Session A** (main checkout): PR-01, 02, 02m, 04, 05, 06, 06b, 09, 10, 11, then the bonus 10b only if PLAN's rules allow it. Owns `packages/*`, `apps/{facilitator,market,worker,agent}`, `workloads/fractal`, root configs, CI, and the scripts listed for A in PLAN section 8.
- **Session B** (worktree): PR-03, 07a, 07b, 08, 08m, then B1 only after PR-10's Masumi minimum acceptance has passed and PR-08m has merged (until then: the Masumi UI and evidence, regressions, recording support, and core fixes in Track B's files). Owns `infra/`, `deploy/`, `Dockerfile`, `workloads/flux`, `apps/web`, `apps/mcp`, `apps/worker/src/workloads/image.ts` plus its one registration line in `workloads/index.ts` (PR-07b), and the scripts listed for B in PLAN section 8.
- Need a change in the other track's files, above all `packages/protocol`? Ask under ASK in your report. Don't edit them. Two files are shared: `pnpm-lock.yaml`, which both sessions commit when they add dependencies to their own packages (conflict rule in the workflow below), and `docs/PLAN.md`, which either session may correct in a PR, calling the change out.

## Non-negotiables

1. Never fake a worker, transaction, execution, event, timing or result. No mock data in production code paths. Fixtures live only in tests and in the UI's dev mode (`import.meta.env.DEV` plus `?fixture=1`), never in the production bundle.
2. No human approval inside the payment flow. My agent pays on its own, within its spend caps.
3. The UI shows only states the backend emitted, in the order they happened.
4. The worker that is paid is the worker that ran the job: payTo is that worker's `PAYOUT_ADDRESS`. For escrow jobs (PR-10), payTo is the Masumi escrow address and the worker that ran the job is the seller; the funds are locked, not paid. In every Masumi text say "locked in escrow". Never say the worker was paid or the funds were released: I implement the lock, not release, refund or dispute.
5. Settle only after delivery. The paid handler answers 400 or above on any failure, so x402 never settles.
6. `packages/protocol` is canonical. Only Session A changes it, and the PR calls the change out.
7. Cut scope before weakening the end-to-end flow. At a missed gate, take the fallback in PLAN section 11.
8. Priorities (PLAN section 0): core marketplace → the Masumi minimum → presentation → bonuses.
   - The Masumi minimum (PLAN 4.9) is required for the Cardano-track submission and is never cut; only Masumi scope beyond it can be cut.
   - PR-02m, the Masumi feasibility gate, is mandatory and answered on Tuesday, with a hard maximum of 45 minutes. It runs right after PR-02 if PR-02 merged by 15:45; if not, right after PR-04.
   - PR-10 starts when PR-09 merges: at 5/5, or at 15:00 at the latest once failover works and `demo-check.sh` is built.
   - After PR-10 merges, in order and never overlapping: the PR-08m real-run check, then the leftover 5/5 runs (a no-PR check), then PR-11's redeploy. Two paid runs never overlap (one wallet), and nothing is redeployed during a run.
   - Feature freeze Wed 17:00. If the Masumi minimum isn't reached by then, it alone continues until 18:00 at the latest. If it's still not reached, the Cardano track is not ready and the main track goes ahead.
   - Session B's escrow card PR-08m is built earlier, from a dev fixture.
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
- No new cloud services, accounts, domains or paid plans without asking.
- Don't deploy while I'm recording. I'll say "recording" and "done recording".
- Deploy only through `scripts/deploy.sh`, which takes a per-host lock so the two sessions never overwrite each other. Never use `--force` on a ref the other session deployed without asking me. Every report says which ref is deployed where.
- Dev routes (`/api/dev/*`) stay behind `PEKKAH_DEV_ROUTES=1` plus `DEMO_TOKEN`. In PR-11 I remove the flag from my env file and you redeploy, which turns them off.

## Payments safety

- Network `cardano:preprod` only. Asset `PEKKAH_ASSET` (tUSDM). Spend caps on at all times: $0.10 per payment, $0.20 per run, $5 per day for the hosted agent. Never pass `spendControls: false`.
- Paid routes are registered directly on `app`, never in a sub-router (PLAN 4.1, fact 11), and a test proves an unpaid request gets 402.
- One payment in flight per buyer wallet. After a settled payment, wait until Blockfrost shows the tx before the next one.
- Test payments are real transactions: keep smoke runs few, and print the Cardanoscan link for each. Masumi locks can't be released with my tooling, so their funds stay locked: keep Masumi test runs to a handful.
- Only the facilitator and the buyer call Blockfrost, with polls at least 5 s apart.

## Job sandbox

- Workers run only the whitelisted workloads (`fractal`, `image`) and the configured images. Params are validated with zod. Docker arguments are an array, never a shell string.
- Job containers always run with `--network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory --cpus --user 1000:1000`, an output bind mount only, and a kill at the deadline + 10 s. Full command in PLAN 7.3.

## Workflow for every PR

Time rules: gates in PLAN are deadlines, never start times. Start each PR the moment its dependencies are merged (PLAN section 10), whatever the clock says, and never wait for a clock time. Timeboxes are maximums: stop as soon as it works. No padding: when the acceptance passes, the PR is done; leftover time goes to the next PR, never to extra polish or scope. If your next PR is blocked by the other session, start the next unblocked one (or a local-only part of the blocked one) and say so in your report.

1. `git fetch origin && git checkout -b pr-NN-slug origin/main`.
2. Build exactly the PR's scope from PLAN section 9. Small commits. Tests for logic.
3. `pnpm check` green → `git fetch && git rebase origin/main` → push → `gh pr create` (title `PR-NN: <name>`). On a `pnpm-lock.yaml` conflict, take origin/main's lockfile, run `pnpm install`, and commit the result; never hand-merge the lockfile.
4. Run the PR's acceptance checks yourself: real commands, real chain, real hosts. Collect the evidence.
5. Send the report below, then don't sit idle while I review. Start your next PR on a branch stacked on this one (`git checkout -b pr-MM-slug` from the current branch). Until I merge, it's local work only: code and tests, no deploys, no payments, no PR. If I ask for changes, switch back, fix, update the report, and continue.
6. When I reply "merge":
   - `gh pr merge <number> --squash`, without `--delete-branch` (it tries to switch to `main` locally).
   - `git push origin --delete pr-NN-slug` and `git fetch origin`.
   - If you stacked work, move it onto main with `git rebase --onto origin/main pr-NN-slug pr-MM-slug` and carry on. Otherwise start the next PR from `origin/main` (step 1).
   - Then delete the old local branch.
   - Never check out `main` itself: the two sessions share one repo through a worktree, and a branch can be checked out in only one of them.

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
- Express: enable `case sensitive routing` and `strict routing`; mount the payment middleware at route level; every async handler wraps its body in try/catch and always ends the response.
- Config only through env (names in PLAN 5.5). Each app validates only the env it uses, with zod, at startup, and exits listing the missing names. Empty strings count as unset (compose passes `""` for an unset `${VAR}`).
- Money is integer atomic units (strings or bigint) internally. USD is for display only.

## Writing

- README, docs, UI copy, commit messages and PR text: first person singular ("I"), never "we". Plain words, short sentences, no hype.
- Code comments only where the reason isn't obvious.
