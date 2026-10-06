#!/usr/bin/env bash
# The demo, end to end, against the deployed market (PLAN 9, PR-09).
#   scripts/demo-check.sh [--runs N] [--scenarios cpu-tight,failover] [--escrow] [--no-runs-md]
# --escrow adds one Masumi escrow run at the end (PR-10); --runs 0 --escrow runs only that.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node_modules/.bin/tsx scripts/demo-check.ts "$@"
