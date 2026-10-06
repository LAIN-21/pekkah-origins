#!/usr/bin/env bash
# Terraform outputs (including the `pekkah` droplet's IP, read by a data
# source) → ~/.pekkah/hosts.json, which deploy.sh, logs.sh and ssh.sh read.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PEKKAH_HOME=${PEKKAH_HOME:-$HOME/.pekkah}
OUT="$PEKKAH_HOME/hosts.json"

outputs=$("$ROOT/scripts/tf.sh" output -json)

umask 077
jq -n --argjson o "$outputs" '{
  generatedAt: (now | todate),
  market: { ip: $o.market_ip.value, reservedIp: $o.market_reserved_ip.value, dropletId: $o.droplet_ids.value.market },
  a: { ip: $o.worker_a_ip.value, dropletId: $o.droplet_ids.value.a },
  b: { ip: $o.worker_b_ip.value, dropletId: $o.droplet_ids.value.b },
  c: { ip: $o.worker_c_ip.value, dropletId: $o.droplet_ids.value.c }
}' >"$OUT.tmp"
mv "$OUT.tmp" "$OUT"

echo "Wrote $OUT"
jq -r 'to_entries[] | select(.value | type == "object") | "  \(.key)\t\(.value.ip)\(if .value.reservedIp then "  (reserved IP \(.value.reservedIp))" else "" end)"' "$OUT"
