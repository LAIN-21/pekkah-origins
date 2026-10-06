#!/usr/bin/env bash
# Thursday teardown (PLAN 13.4). Luis approves the destroy.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

"$ROOT/scripts/tf.sh" destroy "$@"

cat <<'EOF'

Terraform's part is done: the market, workers B and C, the reserved IP and both
firewalls. It never touches the GPU droplet `pekkah` (159.203.0.34), which is
still running and still billing (about $0.76/h).

Luis deletes it himself, after the Top 5 call (or after 17:00 if selected):
  doctl compute droplet delete pekkah
Then check that nothing is left:
  doctl compute droplet list
EOF
