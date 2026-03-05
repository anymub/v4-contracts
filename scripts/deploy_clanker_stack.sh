#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/common.sh"

for v in RPC_URL PRIVATE_KEY OWNER TEAM_FEE_RECIPIENT WETH POOL_MANAGER POSITION_MANAGER PERMIT2 UNIVERSAL_ROUTER BLOCK_DELAY; do
  require_env "$v"
done

if [[ -z "${ENV_NAME:-}" ]]; then
  err "Missing ENV_NAME (expected from scripts/lib/load_env.sh)"
  exit 1
fi

if [[ ! -f "$SCRIPT_DIR/deploy_clanker_stack.js" ]]; then
  err "Missing deploy implementation: $SCRIPT_DIR/deploy_clanker_stack.js"
  exit 1
fi

# Reuse project-root node_modules to keep toolchain consistent
PROJECT_ROOT="$(project_root_from_pwd)"
cd "$PROJECT_ROOT"
node "$SCRIPT_DIR/deploy_clanker_stack.js"
