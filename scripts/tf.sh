#!/usr/bin/env bash
# Terraform wrapper. State lives in ~/.pekkah/terraform.tfstate so it survives
# worktree removal and both checkouts share it.
#
#   scripts/tf.sh init
#   scripts/tf.sh plan        saves the plan to ~/.pekkah/tfplan
#   scripts/tf.sh apply       applies exactly the saved plan (Luis approves it first)
#   scripts/tf.sh destroy
#   scripts/tf.sh output [-json]
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PEKKAH_HOME=${PEKKAH_HOME:-$HOME/.pekkah}
TF_DIR="$ROOT/infra/terraform"
STATE="$PEKKAH_HOME/terraform.tfstate"
PLAN_FILE="$PEKKAH_HOME/tfplan"

usage() {
  echo "usage: scripts/tf.sh <init|plan|apply|destroy|output> [terraform args]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
cmd=$1
shift

mkdir -p "$PEKKAH_HOME"
chmod 700 "$PEKKAH_HOME"

# The token is read from the environment, or from doctl's current auth context
# when the environment lacks it. It is never printed.
if [ -z "${DIGITALOCEAN_TOKEN:-}" ]; then
  if command -v doctl >/dev/null 2>&1 && token=$(doctl auth token 2>/dev/null) && [ -n "$token" ]; then
    export DIGITALOCEAN_TOKEN="$token"
    unset token
  else
    echo "DIGITALOCEAN_TOKEN MISSING (and doctl has no auth context)" >&2
    exit 1
  fi
fi

tf() { terraform -chdir="$TF_DIR" "$@"; }

# On every run, so a stray `terraform init` can never leave this checkout on a
# state file inside the worktree. No -reconfigure: if .terraform points at a
# different state path, init fails and says so instead of switching silently.
ensure_init() {
  tf init -input=false -backend-config="path=$STATE" >/dev/null
}

case "$cmd" in
  init)
    tf init -input=false -backend-config="path=$STATE" "$@"
    ;;
  plan)
    ensure_init
    tf plan -input=false -out="$PLAN_FILE" "$@"
    echo
    echo "Plan saved to $PLAN_FILE. Apply exactly this plan with: scripts/tf.sh apply"
    ;;
  apply)
    ensure_init
    if [ ! -f "$PLAN_FILE" ]; then
      echo "No saved plan. Run scripts/tf.sh plan first and get it approved." >&2
      exit 1
    fi
    tf apply -input=false "$@" "$PLAN_FILE"
    rm -f "$PLAN_FILE"
    ;;
  destroy)
    ensure_init
    tf destroy "$@"
    ;;
  output)
    ensure_init
    tf output "$@"
    ;;
  *)
    usage
    ;;
esac
