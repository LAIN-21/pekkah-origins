# Shared helpers for the host scripts (deploy, logs, ssh). Source it; don't run it.
# Works with macOS's bash 3.2.
#
# Roles: market (market droplet), a (worker on the GPU droplet `pekkah`),
# b, c (CPU workers), flux (the flux project on the GPU droplet).

PEKKAH_HOME=${PEKKAH_HOME:-$HOME/.pekkah}
HOSTS_FILE="$PEKKAH_HOME/hosts.json"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15"

die() {
  echo "error: $*" >&2
  exit 1
}

# Host key in hosts.json. a and flux share the GPU droplet.
role_host() {
  case "$1" in
    market) echo market ;;
    a | flux) echo a ;;
    b) echo b ;;
    c) echo c ;;
    *) return 1 ;;
  esac
}

# Compose project: /opt/pekkah/<project> and `docker compose -p pekkah-<project>`.
role_project() {
  case "$1" in
    market) echo market ;;
    a | b | c) echo worker ;;
    flux) echo flux ;;
    *) return 1 ;;
  esac
}

role_compose_files() {
  case "$1" in
    market) echo "deploy/market.compose.yml" ;;
    a) echo "deploy/worker.compose.yml deploy/worker.gpu.yml" ;;
    b | c) echo "deploy/worker.compose.yml" ;;
    flux) echo "deploy/flux.compose.yml" ;;
    *) return 1 ;;
  esac
}

# Env file under ~/.pekkah/env/ for the role.
role_env_file() {
  case "$1" in
    market) echo market.env ;;
    a) echo worker-a.env ;;
    b) echo worker-b.env ;;
    c) echo worker-c.env ;;
    flux) echo flux.env ;;
    *) return 1 ;;
  esac
}

host_ip() {
  [ -f "$HOSTS_FILE" ] || die "$HOSTS_FILE not found: run scripts/hosts.sh"
  local ip
  ip=$(jq -r --arg h "$1" '.[$h].ip // empty' "$HOSTS_FILE")
  [ -n "$ip" ] || die "no IP for host '$1' in $HOSTS_FILE"
  echo "$ip"
}

# remote <host> <command string>
remote() {
  local host=$1
  shift
  # shellcheck disable=SC2086
  ssh $SSH_OPTS "root@$(host_ip "$host")" "$@"
}

# The compose command on a host, as a string for `remote`.
remote_compose() {
  local role=$1 project files cmd f
  project=$(role_project "$role")
  files=$(role_compose_files "$role")
  cmd="docker compose -p pekkah-$project --env-file /opt/pekkah/env/$project.env"
  for f in $files; do cmd="$cmd -f $f"; done
  echo "$cmd"
}
