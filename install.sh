#!/bin/sh
# Pekkah worker installer: any Linux machine with Docker joins the market with one command.
#
#   curl -fsSL https://raw.githubusercontent.com/LAIN-21/pekkah-origins/main/install.sh | sudo sh -s -- --payout addr_test1…
#
# Options:
#   --payout ADDR          preprod address that receives this worker's payments (required)
#   --market URL           the market to join (default: the hosted market)
#   --id ID --token TOKEN  an allowlisted id and its token: the worker sells. Without them it
#                          joins on probation: listed and measured, but it sells nothing
#   --name NAME            a name for the worker (default: its id)
#   --price USD            its fractal price (default 0.02)
#   --cpus N --memory 4g   job limits (default: every vCPU, half the RAM up to 8g)
#   --uninstall            remove the container, the env file, the data directory and the images
#
# What it does: checks Linux and Docker (it installs nothing silently), detects the GPU, pulls
# the images, runs `probe`, writes /etc/pekkah/worker.env (mode 600), starts the pekkah-worker
# container and waits until the market lists it. docs/WORKER.md explains the trust model.
#
# Everything runs inside main, so a download cut short never runs half a script.

main() {
  set -eu

  MARKET="https://146-190-188-100.sslip.io"
  WORKER_IMAGE="ghcr.io/lain-21/pekkah-worker:latest"
  FRACTAL_IMAGE="ghcr.io/lain-21/pekkah-fractal:latest"
  CONTAINER="pekkah-worker"
  ENV_DIR="/etc/pekkah"
  ENV_FILE="$ENV_DIR/worker.env"
  DATA_DIR="/var/lib/pekkah"
  MARKER="$DATA_DIR/.installed-by-pekkah"
  PAYOUT="" ID="" TOKEN="" NAME="" PRICE="0.02" CPUS="" MEMORY="" UNINSTALL=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --payout) PAYOUT=$(arg "$@"); shift ;;
      --market) MARKET=$(arg "$@"); shift ;;
      --id) ID=$(arg "$@"); shift ;;
      --token) TOKEN=$(arg "$@"); shift ;;
      --name) NAME=$(arg "$@"); shift ;;
      --price) PRICE=$(arg "$@"); shift ;;
      --cpus) CPUS=$(arg "$@"); shift ;;
      --memory) MEMORY=$(arg "$@"); shift ;;
      --worker-image) WORKER_IMAGE=$(arg "$@"); shift ;;
      --fractal-image) FRACTAL_IMAGE=$(arg "$@"); shift ;;
      --uninstall) UNINSTALL=1 ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done

  [ "$(uname -s)" = Linux ] || die "the worker kit runs on Linux only"
  [ "$(id -u)" = 0 ] || die "run it as root: curl -fsSL …/install.sh | sudo sh -s -- …"
  # Workers A, B and C are deployed with scripts/deploy.sh into /opt/pekkah. Never touch them.
  [ ! -e /opt/pekkah ] || die "this host runs a worker deployed by scripts/deploy.sh (/opt/pekkah); install.sh leaves it alone"
  need_docker

  if [ "$UNINSTALL" = 1 ]; then
    uninstall
    return
  fi

  check_inputs
  detect_gpu
  size_jobs

  say "Pulling the images"
  pull "$WORKER_IMAGE"
  pull "$FRACTAL_IMAGE"

  mkdir -p "$DATA_DIR"
  [ -e "$MARKER" ] || [ -n "$(ls -A "$DATA_DIR")" ] || : >"$MARKER"

  say "Probing this machine (the market's calibration jobs, run here)"
  # shellcheck disable=SC2086 # GPU_ARGS is empty or "--gpus all"
  docker run --rm $GPU_ARGS \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$DATA_DIR:$DATA_DIR" \
    -e "FRACTAL_IMAGE=$FRACTAL_IMAGE" -e "JOB_CPUS=$CPUS" -e "JOB_MEMORY=$MEMORY" \
    -e "DATA_DIR=$DATA_DIR" "$WORKER_IMAGE" pnpm -s probe </dev/null ||
    die "the probe failed (see above): nothing was installed"

  write_env
  start_worker
  wait_listed
}

usage() {
  cat <<'EOF'
Usage: install.sh --payout addr_test1… [options]
  --payout ADDR          preprod address that receives this worker's payments (required)
  --market URL           the market to join (default: the hosted market)
  --id ID --token TOKEN  an allowlisted id and its token: the worker sells
  --name NAME            a name for the worker (default: its id)
  --price USD            its fractal price (default 0.02)
  --cpus N --memory 4g   job limits (default: every vCPU, half the RAM up to 8g)
  --uninstall            remove the container, the env file, the data directory and the images
EOF
}

say() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
arg() {
  [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
  printf '%s' "$2"
}
matches() { printf '%s' "$1" | grep -Eq "$2"; }

need_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    printf 'Docker is not installed. Install it first, then run this again:\n\n' >&2
    printf '  curl -fsSL https://get.docker.com | sudo sh\n\n' >&2
    exit 1
  fi
  docker info >/dev/null 2>&1 || die "Docker is installed but not running (try: systemctl start docker)"
}

check_inputs() {
  [ -n "$PAYOUT" ] || die "--payout addr_test1… is required: the address this worker is paid to"
  matches "$PAYOUT" '^addr_test1[02-9ac-hj-np-z]{40,200}$' || die "--payout must be a preprod address (addr_test1…)"
  matches "$MARKET" '^https?://[A-Za-z0-9.-]+(:[0-9]+)?/?$' || die "--market must look like https://host"
  MARKET=${MARKET%/}
  case "$MARKET" in
    https://*) WS_URL="wss://${MARKET#https://}/ws/worker" ;;
    *) WS_URL="ws://${MARKET#http://}/ws/worker" ;;
  esac
  if [ -n "$ID$TOKEN" ]; then
    [ -n "$ID" ] && [ -n "$TOKEN" ] || die "--id and --token go together"
    matches "$TOKEN" '^[A-Za-z0-9_.-]{16,}$' || die "--token must be 16 or more letters, digits, '.', '_' or '-'"
  fi
  [ -z "$ID" ] || matches "$ID" '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$' || die "--id must be letters, digits, '_' or '-' (at most 32)"
  [ -z "$NAME" ] || matches "$NAME" '^[A-Za-z0-9][A-Za-z0-9 ()+./@_-]{0,63}$' || die "--name: at most 64 letters, digits, spaces and ()+-./@_"
  matches "$PRICE" '^(0?\.[0-9]{1,6}|1(\.0{1,6})?)$' || die "--price must be a USD amount up to 1, e.g. 0.02"
  [ -z "$CPUS" ] || matches "$CPUS" '^[0-9]+(\.[0-9]+)?$' || die "--cpus must be a number"
  [ -z "$MEMORY" ] || matches "$MEMORY" '^[0-9]+[bkmgBKMG]?$' || die "--memory must look like 4g"
}

detect_gpu() {
  GPU_ARGS=""
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    gpu=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n 1)
    if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"' ||
      command -v nvidia-container-cli >/dev/null 2>&1; then
      GPU_ARGS="--gpus all"
      say "GPU: $gpu, with the NVIDIA container runtime"
    else
      say "GPU: $gpu, but no NVIDIA Container Toolkit: installing a CPU worker (docs/WORKER.md has the GPU path)"
    fi
  else
    say "No NVIDIA GPU found: a CPU worker"
  fi
}

# The same rule as apps/worker/src/sizing.ts: every vCPU, half the RAM rounded, 1g to 8g.
size_jobs() {
  [ -n "$CPUS" ] || CPUS=$(nproc)
  if [ -z "$MEMORY" ]; then
    MEMORY=$(awk '/^MemTotal:/ { g = int($2 / 1048576 / 2 + 0.5); if (g < 1) g = 1; if (g > 8) g = 8; print g "g" }' /proc/meminfo)
  fi
  say "Jobs get $CPUS CPUs and $MEMORY of memory"
}

pull() {
  if docker pull -q "$1" >/dev/null 2>&1 </dev/null; then
    printf '  %s\n' "$1"
  elif docker image inspect "$1" >/dev/null 2>&1; then
    warn "couldn't pull $1; using the local copy"
  else
    die "couldn't pull $1"
  fi
}

write_env() {
  # Keep a probation id across reinstalls (an allowlisted id is only ever used with --token),
  # and the GPU path's two lines (docs/WORKER.md).
  FLUX_LINES=""
  if [ -f "$ENV_FILE" ]; then
    old=$(sed -n 's/^WORKER_ID=//p' "$ENV_FILE" | head -n 1)
    case "$old" in p-*) [ -n "$ID" ] || ID=$old ;; esac
    FLUX_LINES=$(grep -E '^(FLUX_URL|PRICE_IMAGE_USD)=' "$ENV_FILE" || true)
  fi
  [ -n "$ID" ] || ID="p-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  [ -n "$NAME" ] || NAME=$ID
  umask 077
  mkdir -p "$ENV_DIR"
  chmod 700 "$ENV_DIR"
  tmp=$(mktemp "$ENV_DIR/.worker.env.XXXXXX")
  {
    echo "# Written by install.sh for docker run --env-file: one NAME=value per line, no quotes."
    echo "WORKER_ID=$ID"
    echo "WORKER_NAME=$NAME"
    [ -z "$TOKEN" ] || echo "WORKER_TOKEN=$TOKEN"
    echo "MARKET_WS_URL=$WS_URL"
    echo "PAYOUT_ADDRESS=$PAYOUT"
    echo "PRICE_FRACTAL_USD=$PRICE"
    echo "JOB_CPUS=$CPUS"
    echo "JOB_MEMORY=$MEMORY"
    echo "FRACTAL_IMAGE=$FRACTAL_IMAGE"
    echo "DATA_DIR=$DATA_DIR"
    [ -z "$FLUX_LINES" ] || printf '%s\n' "$FLUX_LINES"
  } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  say "Wrote $ENV_FILE (mode 600) for worker $ID"
}

start_worker() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # The socket makes this container root on the host; the jobs it starts are the sandboxed part.
  # shellcheck disable=SC2086
  docker run -d --name "$CONTAINER" --restart unless-stopped --init $GPU_ARGS \
    --env-file "$ENV_FILE" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$DATA_DIR:$DATA_DIR" \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
    --label pekkah.install=1 "$WORKER_IMAGE" </dev/null >/dev/null
  # The GPU path: the worker reaches the warm FLUX server on the internal pekkah-jobs network.
  if grep -q '^FLUX_URL=' "$ENV_FILE" && docker network inspect pekkah-jobs >/dev/null 2>&1; then
    docker network connect pekkah-jobs "$CONTAINER"
  fi
  say "Started the $CONTAINER container"
}

# The market's view of one worker, through the worker image's Node (no jq needed).
market_view() {
  docker exec "$CONTAINER" node -e '
const [market, id] = process.argv.slice(1);
fetch(new URL("/api/workers", market), { signal: AbortSignal.timeout(10000) })
  .then((r) => r.json())
  .then((workers) => {
    const w = workers.find((x) => x.workerId === id);
    if (!w) return console.log("missing");
    const verified = w.calibration?.fractal?.verified === true ? "verified" : "unverified";
    const selling = w.selling === true ? "selling" : w.selling === false ? "probation" : "unknown";
    console.log(`${w.status} ${verified} ${selling}`);
  })
  .catch(() => console.log("unreachable"));' "$MARKET" "$1" </dev/null 2>/dev/null || echo unreachable
}

wait_listed() {
  say "Waiting for the market to list and calibrate it"
  listed="" view="" i=0
  while [ $i -lt 90 ]; do
    i=$((i + 1))
    restarts=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo 0)
    if [ "$restarts" != 0 ] || [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != true ]; then
      docker logs --tail 5 "$CONTAINER" 2>&1 | grep -v '^{' >&2 || true
      docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
      die "the worker stopped (see above). I removed its container; $ENV_FILE stays"
    fi
    listed=$(docker logs "$CONTAINER" 2>&1 | sed -n 's/.*"listedAs":"\([^"]*\)".*/\1/p' | tail -n 1)
    if [ -n "$listed" ]; then
      view=$(market_view "$listed")
      case "$view" in
        "online verified"* | "busy verified"*) break ;;
        untrusted*) die "the market marked $listed untrusted: its calibration answer was wrong" ;;
      esac
    fi
    sleep 2
  done
  case "$view" in
    *verified*) ;;
    *) die "not listed and calibrated after 3 minutes (listed as '${listed:-?}', market says '${view:-nothing}'). Logs: docker logs $CONTAINER" ;;
  esac
  case "$view" in
    *probation*) role="joining on probation: measured, sells nothing until the market's owner allowlists it" ;;
    *selling*) role="selling" ;;
    *) role="listed" ;;
  esac
  printf '\nPekkah worker installed.\n'
  printf '  Listed as   %s (%s)\n' "$listed" "$role"
  printf '  Calibrated  answer checked by the market\n'
  printf '  Page        %s\n' "$MARKET"
  printf '  Logs        docker logs -f %s\n' "$CONTAINER"
  printf '  Uninstall   curl -fsSL https://raw.githubusercontent.com/LAIN-21/pekkah-origins/main/install.sh | sudo sh -s -- --uninstall\n'
}

uninstall() {
  say "Removing the Pekkah worker"
  image=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)
  fractal=""
  [ ! -f "$ENV_FILE" ] || fractal=$(sed -n 's/^FRACTAL_IMAGE=//p' "$ENV_FILE" | head -n 1)
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  jobs=$(docker ps -aq --filter label=pekkah.job)
  # shellcheck disable=SC2086
  [ -z "$jobs" ] || docker rm -f $jobs >/dev/null
  rm -f "$ENV_FILE"
  rmdir "$ENV_DIR" 2>/dev/null || true
  if [ -e "$MARKER" ]; then
    rm -rf "$DATA_DIR"
  elif [ -d "$DATA_DIR" ]; then
    warn "kept $DATA_DIR: install.sh didn't create it"
  fi
  for img in $image $fractal $(docker images -q --filter reference='ghcr.io/lain-21/pekkah-worker' --filter reference='ghcr.io/lain-21/pekkah-fractal'); do
    docker rmi -f "$img" >/dev/null 2>&1 || true
  done
  printf 'Removed the container, %s, the data directory and the images.\n' "$ENV_FILE"
}

main "$@"
