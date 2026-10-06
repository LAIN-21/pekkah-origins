#!/usr/bin/env bash
# Scans every commit for secrets with gitleaks, in Docker. Exits non-zero on any finding.
# Findings are printed redacted. Works from the main checkout and from a git worktree.
set -euo pipefail

IMAGE="ghcr.io/gitleaks/gitleaks:v8.30.1"

top="$(git rev-parse --show-toplevel)"
common="$(cd "$top" && cd "$(git rev-parse --git-common-dir)" && pwd -P)"
top="$(cd "$top" && pwd -P)"

# Mount at identical paths so a worktree's .git file still points at its common git dir.
mounts=(-v "$top:$top:ro")
case "$common" in
  "$top"/*) ;;
  *) mounts+=(-v "$common:$common:ro") ;;
esac

docker run --rm "${mounts[@]}" -w "$top" --entrypoint sh "$IMAGE" -c \
  'git config --global --add safe.directory "*" && gitleaks git --redact --no-banner --verbose .'
