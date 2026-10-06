#!/usr/bin/env bash
# Deploy a role from GitHub to its host.
#
#   scripts/deploy.sh <market|a|b|c|flux|all> [--ref <branch>] [--force]
#
# - Hosts check out the ref from GitHub, so it must be pushed. Default ref: main.
# - One deploy per host at a time: a lock in ~/.pekkah/locks/<host>.lock that
#   a second deploy waits for (both sessions run on the same Mac).
# - Refuses to replace a different non-main ref deployed less than 20 minutes
#   earlier, unless --force (only with Luis's OK).
# - `all` is market, a, b, c. flux is deployed only by name.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"

REPO_URL=${PEKKAH_REPO_URL:-https://github.com/LAIN-21/pekkah-origins.git}
LOCK_WAIT_SEC=${LOCK_WAIT_SEC:-1800}
FORCE_WINDOW_SEC=1200

usage() {
  echo "usage: scripts/deploy.sh <market|a|b|c|flux|all> [--ref <branch>] [--force]" >&2
  exit 2
}

target=""
ref=main
force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref)
      [ $# -ge 2 ] || usage
      ref=$2
      shift 2
      ;;
    --force)
      force=1
      shift
      ;;
    market | a | b | c | flux | all)
      [ -z "$target" ] || usage
      target=$1
      shift
      ;;
    *) usage ;;
  esac
done
[ -n "$target" ] || usage

session_label() {
  local top branch
  top=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || echo "$ROOT")
  branch=$(git -C "$ROOT" branch --show-current 2>/dev/null || true)
  case "$top" in
    */.claude/worktrees/*) echo "session-B:${branch:-detached}" ;;
    *) echo "session-A:${branch:-detached}" ;;
  esac
}
SESSION=${PEKKAH_SESSION:-$(session_label)}

# Resolve the ref on GitHub. Hosts deploy that exact commit.
sha=$(git ls-remote "$REPO_URL" "refs/heads/$ref" "refs/tags/$ref" | head -1 | cut -f1)
if [ -z "$sha" ]; then
  if printf '%s' "$ref" | grep -qE '^[0-9a-f]{40}$'; then
    sha=$ref
  else
    die "ref '$ref' is not on origin. Push it first (hosts fetch from GitHub)."
  fi
fi

LOCK_DIR=""
TMP_ENV=""
cleanup() {
  [ -z "$TMP_ENV" ] || rm -f "$TMP_ENV"
  [ -z "$LOCK_DIR" ] || rm -rf "$LOCK_DIR"
  LOCK_DIR=""
}
trap cleanup EXIT
trap 'exit 130' INT TERM

acquire_lock() {
  local host=$1 dir owner pid waited=0 said=0
  dir="$PEKKAH_HOME/locks/$host.lock"
  mkdir -p "$PEKKAH_HOME/locks"
  while ! mkdir "$dir" 2>/dev/null; do
    owner=$(cat "$dir/owner" 2>/dev/null || echo "unknown")
    pid=$(printf '%s' "$owner" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p')
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "Removing a stale lock on $host ($owner)"
      rm -rf "$dir"
      continue
    fi
    if [ $said -eq 0 ]; then
      echo "Waiting for the deploy lock on $host, held by: $owner"
      said=1
    fi
    sleep 3
    waited=$((waited + 3))
    [ $waited -lt "$LOCK_WAIT_SEC" ] || die "gave up waiting for the lock on $host after ${LOCK_WAIT_SEC}s"
  done
  LOCK_DIR=$dir
  echo "session=$SESSION ref=$ref pid=$$ since=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$dir/owner"
  [ $said -eq 0 ] || echo "Got the deploy lock on $host after ${waited}s"
}

release_lock() {
  [ -z "$LOCK_DIR" ] || rm -rf "$LOCK_DIR"
  LOCK_DIR=""
}

# Refuse to replace someone else's recent non-main deploy without --force.
check_current() {
  local host=$1 project=$2 current cur_ref cur_sha cur_epoch cur_session age
  current=$(remote "$host" "cat /opt/pekkah/$project/DEPLOYED 2>/dev/null || true")
  cur_ref=$(printf '%s\n' "$current" | sed -n 's/^ref=//p')
  [ -n "$cur_ref" ] || {
    echo "Nothing deployed yet for pekkah-$project on $host."
    return 0
  }
  cur_sha=$(printf '%s\n' "$current" | sed -n 's/^sha=//p')
  cur_epoch=$(printf '%s\n' "$current" | sed -n 's/^epoch=//p')
  cur_session=$(printf '%s\n' "$current" | sed -n 's/^session=//p')
  age=$(($(date +%s) - ${cur_epoch:-0}))
  echo "Currently deployed: pekkah-$project on $host = $cur_ref @ $(printf '%s' "$cur_sha" | cut -c1-7), $((age / 60)) min ago, by $cur_session"
  if [ "$cur_ref" != main ] && [ "$cur_ref" != "$ref" ] && [ $age -lt $FORCE_WINDOW_SEC ] && [ $force -eq 0 ]; then
    die "refusing to replace $cur_ref (deployed by $cur_session less than 20 min ago). Ask Luis, then rerun with --force."
  fi
}

# Install git and the compose plugin if missing, create pekkah-jobs on A,
# then clone or fetch and check out the exact commit.
prepare_host() {
  local host=$1 role=$2 project=$3
  remote "$host" "bash -s -- $project $REPO_URL $sha $role" <<'REMOTE'
set -euo pipefail
project=$1 repo=$2 sha=$3 role=$4
export DEBIAN_FRONTEND=noninteractive

# New droplets may still be installing Docker from cloud-init.
if command -v cloud-init >/dev/null 2>&1; then
  timeout 600 cloud-init status --wait >/dev/null 2>&1 || true
fi
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh

if dpkg -s docker-ce >/dev/null 2>&1; then
  compose_pkg=docker-compose-plugin buildx_pkg=docker-buildx-plugin
else
  compose_pkg=docker-compose-v2 buildx_pkg=docker-buildx
fi
need=""
command -v git >/dev/null 2>&1 || need="$need git"
docker compose version >/dev/null 2>&1 || need="$need $compose_pkg"
docker buildx version >/dev/null 2>&1 || need="$need $buildx_pkg"
if [ -n "$need" ]; then
  echo "Installing:$need"
  apt-get -o DPkg::Lock::Timeout=300 update -qq
  # shellcheck disable=SC2086
  apt-get -o DPkg::Lock::Timeout=300 install -y -qq $need >/dev/null
fi

install -d -m 700 /opt/pekkah/env
install -d /var/lib/pekkah

if [ "$role" = a ] || [ "$role" = flux ]; then
  docker network inspect pekkah-jobs >/dev/null 2>&1 || docker network create --internal pekkah-jobs >/dev/null
fi

dir=/opt/pekkah/$project
[ -d "$dir/.git" ] || git clone --quiet "$repo" "$dir"
git -C "$dir" fetch --quiet --prune --tags origin '+refs/heads/*:refs/remotes/origin/*'
git -C "$dir" cat-file -e "$sha^{commit}" 2>/dev/null || git -C "$dir" fetch --quiet origin "$sha"
git -C "$dir" checkout --quiet --force --detach "$sha"
git -C "$dir" clean -fdq -e DEPLOYED
echo "Checked out $(git -C "$dir" log -1 --format='%h %s') in $dir"
REMOTE
}

# Copy the role's env file to /opt/pekkah/env/<project>.env with mode 600.
# __FILL_ME__ placeholders become empty, so apps report them missing.
push_env() {
  local host=$1 project=$2 src=$3 ip
  ip=$(host_ip "$host")
  TMP_ENV=$(mktemp "$PEKKAH_HOME/.deploy-env.XXXXXX")
  sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)="?__FILL_ME__"?[[:space:]]*$/\1=/' "$src" >"$TMP_ENV"
  remote "$host" "install -m 600 /dev/null /opt/pekkah/env/$project.env.new"
  # shellcheck disable=SC2086
  scp -q $SSH_OPTS "$TMP_ENV" "root@$ip:/opt/pekkah/env/$project.env.new"
  remote "$host" "chmod 600 /opt/pekkah/env/$project.env.new && mv /opt/pekkah/env/$project.env.new /opt/pekkah/env/$project.env"
  rm -f "$TMP_ENV"
  TMP_ENV=""
  echo "Copied $(basename "$src") to /opt/pekkah/env/$project.env (mode 600)"
}

compose_up() {
  local host=$1 role=$2 project=$3 compose
  compose=$(remote_compose "$role")
  remote "$host" "bash -s -- $project $sha $ref $(printf '%q' "$SESSION")" <<REMOTE
set -euo pipefail
project=\$1 sha=\$2 ref=\$3 session=\$4
cd /opt/pekkah/\$project
export GIT_SHA=\$sha
if [ "\$project" = worker ]; then
  if [ -f workloads/fractal/Dockerfile ]; then
    echo "Building pekkah/fractal:local"
    docker build -q -t pekkah/fractal:local workloads/fractal >/dev/null
  else
    echo "No workloads/fractal yet; skipping the fractal image"
  fi
fi
if [ -z "\$($compose config --services)" ]; then
  echo "pekkah-\$project has no services yet; nothing to start"
else
  echo "Building and starting pekkah-\$project"
  # Same as up --build, but the build log stays quiet (errors still print).
  $compose build --quiet
  $compose up -d --remove-orphans --quiet-pull
fi
printf 'ref=%s\nsha=%s\ntime=%s\nepoch=%s\nsession=%s\n' "\$ref" "\$sha" "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\$(date +%s)" "\$session" > DEPLOYED
REMOTE
}

env_value() {
  # Reads one non-secret value (e.g. PUBLIC_URL) from an env file without sourcing it.
  sed -n "s/^$2=//p" "$1" | tail -1 | sed -E 's/^"(.*)"$/\1/'
}

health_check() {
  local host=$1 role=$2 project=$3 envsrc=$4 compose short body url i
  compose=$(remote_compose "$role")
  short=$(printf '%s' "$sha" | cut -c1-7)
  sleep 5
  remote "$host" "cd /opt/pekkah/$project && $compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'"
  case "$role" in
    market)
      body=""
      for i in $(seq 1 24); do
        body=$(remote "$host" "cd /opt/pekkah/$project && $compose exec -T market node -e \"fetch('http://127.0.0.1:'+(process.env.MARKET_PORT||8080)+'/api/health').then(r=>r.text()).then(t=>console.log(t),()=>process.exit(1))\"" 2>/dev/null) && break
        body=""
        sleep 5
      done
      [ -n "$body" ] || die "market /api/health did not answer inside the container after 2 min"
      echo "market /api/health (inside the container): $body"
      url=$(env_value "$envsrc" PUBLIC_URL)
      if [ -z "$url" ] || [ "$url" = "__FILL_ME__" ]; then
        url="http://$(jq -r '.market.reservedIp' "$HOSTS_FILE")"
      fi
      for i in $(seq 1 18); do
        if body=$(curl -fsS -m 5 "$url/api/health" 2>/dev/null); then
          echo "$url/api/health: $body"
          break
        fi
        body=""
        sleep 5
      done
      [ -n "$body" ] || echo "warning: $url/api/health did not answer within 90 s (Caddy may still be getting a certificate)"
      case "$body" in
        *"$short"*) echo "OK: the market reports sha $short" ;;
        *) echo "warning: the health response doesn't contain sha $short" ;;
      esac
      ;;
    a | b | c)
      remote "$host" "docker image inspect -f 'pekkah/worker:local revision {{index .Config.Labels \"org.opencontainers.image.revision\"}}' pekkah/worker:local; cd /opt/pekkah/$project && $compose ps --status running --services | grep -qx worker && echo 'OK: worker container is running' || { echo 'worker container is not running'; exit 1; }"
      ;;
  esac
}

deploy_role() {
  local role=$1 host project envsrc
  host=$(role_host "$role")
  project=$(role_project "$role")
  envsrc="$PEKKAH_HOME/env/$(role_env_file "$role")"
  [ -f "$envsrc" ] || die "$envsrc not found: run scripts/init-env.sh"

  echo "==> $role: pekkah-$project on $host ($(host_ip "$host")), ref $ref @ $(printf '%s' "$sha" | cut -c1-7), by $SESSION"
  acquire_lock "$host"
  check_current "$host" "$project"
  prepare_host "$host" "$role" "$project"
  push_env "$host" "$project" "$envsrc"
  compose_up "$host" "$role" "$project"
  health_check "$host" "$role" "$project" "$envsrc"
  release_lock
  echo "==> $role: deployed $ref @ $(printf '%s' "$sha" | cut -c1-7) to pekkah-$project on $host"
}

if [ "$target" = all ]; then
  for r in market a b c; do deploy_role "$r"; done
else
  deploy_role "$target"
fi
