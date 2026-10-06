#!/usr/bin/env bash
# Creates the env files in ~/.pekkah from the examples, or appends only the
# names a file lacks. Never overwrites a value and never prints one.
#
#   scripts/init-env.sh                     names, defaults, generated tokens, __FILL_ME__ for secrets
#   scripts/init-env.sh --seed-from-local   also copies values that ~/.pekkah/local.env already has
#                                           (Blockfrost, mnemonics, seller addresses → PAYOUT_ADDRESS)
#                                           into names that are missing, empty or __FILL_ME__
#
# Files: env/worker-a.env, env/worker-b.env, env/worker-c.env, env/flux.env,
# env/market.env (from deploy/env-examples), and local.env (from the root
# local.env.example, when it exists). Run scripts/hosts.sh first so the public
# URLs can be derived from the reserved IP.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PEKKAH_HOME=${PEKKAH_HOME:-$HOME/.pekkah}
EXAMPLES="$ROOT/deploy/env-examples"
LOCAL_ENV=${PEKKAH_ENV_FILE:-$PEKKAH_HOME/local.env}

seed=0
case "${1:-}" in
  "") ;;
  --seed-from-local) seed=1 ;;
  *)
    echo "usage: scripts/init-env.sh [--seed-from-local]" >&2
    exit 2
    ;;
esac

umask 077
mkdir -p "$PEKKAH_HOME/env" "$PEKKAH_HOME/locks"
chmod 700 "$PEKKAH_HOME" "$PEKKAH_HOME/env"

ALWAYS_GENERATE=" AGENT_TOKEN DEMO_TOKEN WORKER_TOKEN "
# Names --seed-from-local may copy from local.env.
SEEDABLE=" BLOCKFROST_PROJECT_ID BLOCKFROST_BASE_URL BUYER_MNEMONIC SELLER_A_MNEMONIC SELLER_A_ADDRESS SELLER_B_ADDRESS SELLER_C_ADDRESS PEKKAH_ASSET "
# The root local.env.example leaves every name empty (empty = the app's default).
# In local.env only these get __FILL_ME__; the rest are written empty.
LOCAL_SECRETS=" BLOCKFROST_PROJECT_ID BUYER_MNEMONIC SELLER_A_MNEMONIC SELLER_A_ADDRESS SELLER_B_ADDRESS SELLER_C_ADDRESS "
QUOTED=" BUYER_MNEMONIC SELLER_A_MNEMONIC "

has_name() { grep -qE "^$2=" "$1" 2>/dev/null; }

# Raw value without surrounding quotes. Callers compare it; nothing prints it.
get_value() {
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -1 | sed -E 's/^"(.*)"$/\1/'
}

is_real() { [ -n "$1" ] && [ "$1" != "__FILL_ME__" ]; }

markers() { sed -n "s/^# @$2 //p" "$1" | tr '\n' ' '; }

public_host=""
if [ -f "$PEKKAH_HOME/hosts.json" ]; then
  rip=$(jq -r '.market.reservedIp // empty' "$PEKKAH_HOME/hosts.json")
  [ -z "$rip" ] || public_host="$(printf '%s' "$rip" | tr . -).sslip.io"
fi

# Builds A:<token>,B:<token>,C:<token> from the worker files, or nothing.
worker_tokens() {
  local out="" id tok
  for id in A B C; do
    tok=$(get_value "$PEKKAH_HOME/env/worker-$(printf '%s' "$id" | tr 'A-Z' 'a-z').env" WORKER_TOKEN)
    is_real "$tok" || return 0
    out="$out${out:+,}$id:$tok"
  done
  printf '%s' "$out"
}

# The local.env line for a seedable name (PAYOUT_ADDRESS comes from
# SELLER_<id>_ADDRESS), or nothing. Raw, so quoting (mnemonics) is kept.
seed_line() {
  local name=$1 wid=$2 src=""
  case "$SEEDABLE" in *" $name "*) src=$name ;; esac
  [ "$name" != PAYOUT_ADDRESS ] || src="SELLER_${wid}_ADDRESS"
  [ -n "$src" ] || return 0
  is_real "$(get_value "$LOCAL_ENV" "$src")" || return 0
  printf '%s=%s' "$name" "$(sed -n "s/^$src=//p" "$LOCAL_ENV" | tail -1)"
}

# replace_line <file> <name> <new line>: the value travels through the environment, never argv.
replace_line() {
  local tmp
  tmp=$(mktemp "$1.XXXXXX")
  NEW_LINE=$3 awk -v n="$2=" 'index($0, n) == 1 { print ENVIRON["NEW_LINE"]; next } { print }' "$1" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$1"
}

# process <template> <target>
process() {
  local tpl=$1 target=$2 generate optional line name default value worker_id
  local added="" generated="" fill="" seeded="" derived=""
  generate="$ALWAYS_GENERATE$(markers "$tpl" generate)"
  optional=" $(markers "$tpl" optional)"
  [ -f "$target" ] || : >"$target"
  chmod 600 "$target"
  # Appending must start on a new line.
  if [ -s "$target" ] && [ -n "$(tail -c1 "$target")" ]; then echo >>"$target"; fi
  worker_id=$(get_value "$target" WORKER_ID)
  [ -n "$worker_id" ] || worker_id=$(get_value "$tpl" WORKER_ID)

  # Two passes: WORKER_TOKENS last, so it can read the tokens written first.
  for pass in 1 2; do
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in [A-Za-z_]*=*) ;; *) continue ;; esac
      name=${line%%=*}
      default=${line#*=}
      if [ "$name" = WORKER_TOKENS ]; then [ $pass -eq 2 ] || continue; else [ $pass -eq 1 ] || continue; fi
      if has_name "$target" "$name"; then
        # A placeholder or an empty value isn't a value: --seed-from-local may fill it.
        if [ $seed -eq 1 ] && [ "$target" != "$LOCAL_ENV" ] && ! is_real "$(get_value "$target" "$name")"; then
          value=$(seed_line "$name" "$worker_id")
          if [ -n "$value" ]; then
            replace_line "$target" "$name" "$value"
            seeded="$seeded $name"
          fi
        fi
        continue
      fi

      value=""
      case "$generate" in *" $name "*)
        value="$name=$(openssl rand -hex 16)"
        generated="$generated $name"
        ;;
      esac
      if [ -z "$value" ] && [ "$name" = WORKER_TOKENS ]; then
        if [ "$(basename "$target")" = market.env ]; then
          v=$(worker_tokens)
        else
          v=$(get_value "$target" WORKER_TOKEN)
          [ -z "$v" ] || v="${worker_id:-A}:$v"
        fi
        if is_real "$v"; then
          value="$name=$v"
          derived="$derived $name"
        fi
      fi
      if [ -z "$value" ] && [ -n "$public_host" ] && [ "$target" != "$LOCAL_ENV" ]; then
        case "$name" in
          PUBLIC_HOST) value="$name=$public_host" ;;
          PUBLIC_URL) value="$name=https://$public_host" ;;
          MARKET_WS_URL) value="$name=wss://$public_host/ws/worker" ;;
        esac
        [ -z "$value" ] || derived="$derived $name"
      fi
      if [ -z "$value" ] && [ $seed -eq 1 ] && [ "$target" != "$LOCAL_ENV" ]; then
        value=$(seed_line "$name" "$worker_id")
        [ -z "$value" ] || seeded="$seeded $name"
      fi
      if [ -z "$value" ] && [ "$target" = "$LOCAL_ENV" ] && [ -z "$default" ]; then
        case "$LOCAL_SECRETS" in
          *" $name "*)
            case "$QUOTED" in *" $name "*) value="$name=\"__FILL_ME__\"" ;; *) value="$name=__FILL_ME__" ;; esac
            fill="$fill $name"
            ;;
          *) value="$name=" ;;
        esac
      fi
      if [ -z "$value" ]; then
        case "$optional" in
          *" $name "*) value="$name=$default" ;;
          *)
            if [ "$default" = '""' ]; then
              value="$name=\"__FILL_ME__\""
              fill="$fill $name"
            elif [ -z "$default" ]; then
              value="$name=__FILL_ME__"
              fill="$fill $name"
            else
              value="$name=$default"
            fi
            ;;
        esac
      fi
      printf '%s\n' "$value" >>"$target"
      added="$added $name"
    done <"$tpl"
  done

  local label=${target#"$PEKKAH_HOME"/}
  if [ -z "$added$seeded" ]; then
    echo "$label: complete, nothing added"
  else
    [ -z "$added" ] || echo "$label: added$added"
    [ -n "$added" ] || echo "$label:"
    [ -z "$generated" ] || echo "    generated:$generated"
    [ -z "$derived" ] || echo "    derived:$derived"
    [ -z "$seeded" ] || echo "    copied from local.env:$seeded"
    [ -z "$fill" ] || echo "    to fill (__FILL_ME__):$fill"
  fi
}

for role in worker-a worker-b worker-c flux market; do
  process "$EXAMPLES/$role.env.example" "$PEKKAH_HOME/env/$role.env"
done

if [ -f "$ROOT/local.env.example" ]; then
  process "$ROOT/local.env.example" "$LOCAL_ENV"
else
  echo "local.env: skipped (no local.env.example at the repo root yet)"
fi

[ -n "$public_host" ] || echo "note: no hosts.json yet, so PUBLIC_HOST, PUBLIC_URL and MARKET_WS_URL are __FILL_ME__. Run scripts/hosts.sh, then rerun this."
echo "Fill every __FILL_ME__ in a text editor, then run scripts/check-env.sh."
