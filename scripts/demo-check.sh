#!/usr/bin/env bash
# The demo, end to end, against the deployed market (PLAN 9, PR-09).
#   scripts/demo-check.sh [--runs N] [--scenarios cpu-tight,failover] [--escrow [--wait-release]] [--no-runs-md]
# --escrow adds one Masumi escrow run at the end (PR-10); --runs 0 --escrow runs only that.
# --wait-release (PR-16) waits for the escrow's release after its unlock and records it.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node_modules/.bin/tsx scripts/demo-check.ts "$@"
