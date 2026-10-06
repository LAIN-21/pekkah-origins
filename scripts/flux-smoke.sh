#!/usr/bin/env bash
# Checks for the warm flux server on worker A (PR-07a).
#
#   scripts/flux-smoke.sh preflight   >= 80 GB free on /, nvidia-smi, HF_TOKEN set (names only)
#   scripts/flux-smoke.sh fetch       runs the one-off flux-fetch (verifies or downloads the weights)
#   scripts/flux-smoke.sh [generate] [--runs N] [--size 768|1024] [--steps 1-4] [--seed N] [--prompt TEXT]
#                                     calls /generate from a throwaway container on pekkah-jobs,
#                                     prints timings, copies the PNGs to results/flux-smoke/
#   scripts/flux-smoke.sh egress      shows the flux container can't reach huggingface.co
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/lib.sh
. "$ROOT/scripts/lib.sh"

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

cmd=generate
case "${1:-}" in
  preflight | fetch | generate | egress)
    cmd=$1
    shift
    ;;
  -h | --help) usage ;;
esac

COMPOSE=$(remote_compose flux)

case "$cmd" in
  preflight)
    remote a "df -BG --output=avail / | tail -1 | tr -dc 0-9 | xargs -I{} sh -c 'echo \"disk: {} GB free on /\"; [ {} -ge 80 ]' && nvidia-smi --query-gpu=name,driver_version,memory.used,memory.total --format=csv,noheader"
    "$ROOT/scripts/check-env.sh" flux | grep -E 'HF_TOKEN'
    ;;

  fetch)
    remote a "cd /opt/pekkah/flux && $COMPOSE --profile fetch run --rm flux-fetch && echo && du -sh /var/lib/pekkah/hf && ls /var/lib/pekkah/hf && if ls /var/lib/pekkah/hf/*.safetensors >/dev/null 2>&1; then echo 'unexpected single-file checkpoint at the root:'; ls -la /var/lib/pekkah/hf/*.safetensors; exit 1; else echo 'no single-file checkpoint at the root'; fi"
    ;;

  egress)
    # The probe prints REACHED or BLOCKED for each target. A probe that doesn't
    # run (flux stopped, exec failed) proves nothing, so it fails the check.
    if ! out=$(remote a "cd /opt/pekkah/flux && $COMPOSE exec -T flux python -" 2>&1 <<'PY'
import socket, urllib.request

try:
    urllib.request.urlopen("https://huggingface.co", timeout=8)
    print("REACHED https://huggingface.co")
except Exception as e:
    print(f"BLOCKED https://huggingface.co: {type(e).__name__}: {e}")
s = socket.socket()
s.settimeout(5)
try:
    s.connect(("1.1.1.1", 443))
    print("REACHED 1.1.1.1:443")
except OSError as e:
    print(f"BLOCKED 1.1.1.1:443: {e}")
PY
    ); then
      echo "INCONCLUSIVE: the probe couldn't run in the flux container:"
      printf '%s\n' "$out" | tail -3
      exit 1
    fi
    printf '%s\n' "$out"
    case "$out" in
      *REACHED*)
        echo "FAIL: the flux container has internet access"
        exit 1
        ;;
      *"BLOCKED https://huggingface.co"*"BLOCKED 1.1.1.1:443"*)
        echo "OK: no egress from the flux container"
        ;;
      *)
        echo "INCONCLUSIVE: unexpected probe output"
        exit 1
        ;;
    esac
    ;;

  generate)
    runs=3 size=1024 steps=4 seed=7
    prompt="A lighthouse on a rocky coast at dusk, warm light in the window, oil painting"
    while [ $# -gt 0 ]; do
      case "$1" in
        --runs) runs=$2; shift 2 ;;
        --size) size=$2; shift 2 ;;
        --steps) steps=$2; shift 2 ;;
        --seed) seed=$2; shift 2 ;;
        --prompt) prompt=$2; shift 2 ;;
        *) usage ;;
      esac
    done
    remote a "bash -s -- $runs $size $steps $seed $(printf '%q' "$prompt")" <<'REMOTE'
set -euo pipefail
export RUNS=$1 SIZE=$2 STEPS=$3 SEED=$4 PROMPT=$5
out=/tmp/pekkah-flux-smoke
rm -rf "$out" && mkdir -p "$out"
# A throwaway container on the internal network, using the flux image for Python.
docker run --rm -i --network pekkah-jobs --user 0:0 -v "$out:/out" \
  -e RUNS -e SIZE -e STEPS -e SEED -e PROMPT --entrypoint python pekkah/flux:local - <<'PY'
import hashlib, json, os, time, urllib.request

base = "http://flux:8000"
print("health before:", urllib.request.urlopen(base + "/health", timeout=10).read().decode())
runs, size, steps, seed = (int(os.environ[k]) for k in ("RUNS", "SIZE", "STEPS", "SEED"))
for i in range(runs):
    body = json.dumps({"prompt": os.environ["PROMPT"], "seed": seed + i, "size": size, "steps": steps}).encode()
    req = urllib.request.Request(base + "/generate", data=body, headers={"content-type": "application/json"})
    started = time.monotonic()
    with urllib.request.urlopen(req, timeout=300) as res:
        png = res.read()
        server_ms = res.headers.get("X-Duration-Ms")
    wall = time.monotonic() - started
    with open(f"/out/flux-{i + 1}.png", "wb") as f:
        f.write(png)
    print(f"run {i + 1}: {wall:.2f} s wall, {int(server_ms) / 1000:.2f} s in the server, "
          f"{size}x{size}, {steps} steps, seed {seed + i}, {len(png)} bytes, sha256 {hashlib.sha256(png).hexdigest()}")
print("health after:", urllib.request.urlopen(base + "/health", timeout=10).read().decode())
PY
REMOTE
    dest="$ROOT/results/flux-smoke"
    mkdir -p "$dest"
    # shellcheck disable=SC2086
    scp -q $SSH_OPTS "root@$(host_ip a):/tmp/pekkah-flux-smoke/*.png" "$dest/"
    echo "Copied to ${dest#"$ROOT"/}:"
    ls -1 "$dest"
    ;;
esac
