#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '%s\n' "$*"
}

err() {
  printf '%s\n' "$*" >&2
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    err "Missing required env var: $name"
    exit 1
  fi
}

project_root_from_pwd() {
  # v4-contracts/scripts -> repo root is ../..
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$script_dir/../../.." && pwd
}

v4_root_from_pwd() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$script_dir/../" && pwd
}
