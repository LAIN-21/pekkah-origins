#!/usr/bin/env bash
# Shell on a host, or one command:  scripts/ssh.sh <market|a|b|c|flux> [command...]
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"

[ $# -ge 1 ] || {
  echo "usage: scripts/ssh.sh <market|a|b|c|flux> [command...]" >&2
  exit 2
}
host=$(role_host "$1") || die "unknown role '$1'"
shift

tty=""
[ $# -gt 0 ] || tty="-t"
# shellcheck disable=SC2086
exec ssh $SSH_OPTS $tty "root@$(host_ip "$host")" "$@"
