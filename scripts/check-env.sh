#!/usr/bin/env bash
# Prints each env name with `set` or `MISSING`, never a value. Parses the files
# line by line (never `source`: bash would run the words of an unquoted mnemonic).
#
#   scripts/check-env.sh [all|local|market|worker-a|worker-b|worker-c|flux]
#
# Exits 1 when a required name is MISSING or the cross-file checks fail.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PEKKAH_HOME=${PEKKAH_HOME:-$HOME/.pekkah}
EXAMPLES="$ROOT/deploy/env-examples"
LOCAL_ENV=${PEKKAH_ENV_FILE:-$PEKKAH_HOME/local.env}

which=${1:-all}
status=0

get_value() {
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -1 | sed -E 's/^"(.*)"$/\1/'
}

is_real() { [ -n "$1" ] && [ "$1" != "__FILL_ME__" ]; }

# The root local.env.example (Track A) leaves every name empty, meaning the app's
# default; in local.env only these must be set.
LOCAL_REQUIRED=" BLOCKFROST_PROJECT_ID BUYER_MNEMONIC SELLER_A_ADDRESS SELLER_B_ADDRESS SELLER_C_ADDRESS DEMO_TOKEN AGENT_TOKEN "

# check <file> <template or empty> [required names; all others optional]
check() {
  local file=$1 tpl=$2 required=${3:-} optional="" names="" name value
  echo "${file/#$HOME/~}"
  if [ ! -f "$file" ]; then
    echo "  (file missing: run scripts/init-env.sh)"
    status=1
    return
  fi
  if [ -n "$tpl" ] && [ -f "$tpl" ]; then
    optional=" $(sed -n 's/^# @optional //p' "$tpl" | tr '\n' ' ')"
    names=$(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$tpl")
  fi
  # Names in the file that the template doesn't list are checked too.
  names="$names $(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$file")"
  if [ -n "$required" ]; then
    for name in $names; do
      case "$required" in *" $name "*) ;; *) optional="$optional $name " ;; esac
    done
  fi
  for name in $(printf '%s\n' $names | awk '!seen[$0]++'); do
    if ! grep -qE "^$name=" "$file"; then
      case "$optional" in
        *" $name "*) printf '  %-26s %s\n' "$name" "absent (optional)" ;;
        *)
          printf '  %-26s %s\n' "$name" "MISSING"
          status=1
          ;;
      esac
      continue
    fi
    value=$(get_value "$file" "$name")
    if is_real "$value"; then
      printf '  %-26s %s\n' "$name" "set"
    else
      case "$optional" in
        *" $name "*) printf '  %-26s %s\n' "$name" "empty (optional)" ;;
        *)
          printf '  %-26s %s\n' "$name" "MISSING"
          status=1
          ;;
      esac
    fi
  done
}

# Cross-file checks between market.env and the worker files. Values are only compared.
cross_check() {
  local market="$PEKKAH_HOME/env/market.env" tokens id lower tok payout seller ok
  [ -f "$market" ] || return 0
  echo "cross-file checks"
  tokens=",$(get_value "$market" WORKER_TOKENS),"
  for id in A B C; do
    lower=$(printf '%s' "$id" | tr 'A-Z' 'a-z')
    tok=$(get_value "$PEKKAH_HOME/env/worker-$lower.env" WORKER_TOKEN)
    ok=no
    if is_real "$tok"; then
      case "$tokens" in *",$id:$tok,"*) ok=yes ;; esac
    fi
    printf '  %-48s %s\n' "WORKER_TOKENS has worker-$lower's WORKER_TOKEN" "$ok"
    [ "$ok" = yes ] || status=1

    payout=$(get_value "$PEKKAH_HOME/env/worker-$lower.env" PAYOUT_ADDRESS)
    seller=$(get_value "$market" "SELLER_${id}_ADDRESS")
    if is_real "$payout" && is_real "$seller"; then
      if [ "$payout" = "$seller" ]; then ok=yes; else ok=NO; fi
      printf '  %-48s %s\n' "worker-$lower PAYOUT_ADDRESS = SELLER_${id}_ADDRESS" "$ok"
      [ "$ok" = yes ] || status=1
    fi
  done
}

case "$which" in
  all)
    check "$LOCAL_ENV" "$ROOT/local.env.example" "$LOCAL_REQUIRED"
    for role in market worker-a worker-b worker-c flux; do
      check "$PEKKAH_HOME/env/$role.env" "$EXAMPLES/$role.env.example"
    done
    cross_check
    ;;
  local) check "$LOCAL_ENV" "$ROOT/local.env.example" "$LOCAL_REQUIRED" ;;
  market | worker-a | worker-b | worker-c | flux)
    check "$PEKKAH_HOME/env/$which.env" "$EXAMPLES/$which.env.example"
    ;;
  *)
    echo "usage: scripts/check-env.sh [all|local|market|worker-a|worker-b|worker-c|flux]" >&2
    exit 2
    ;;
esac

exit $status
