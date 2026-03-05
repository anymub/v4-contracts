#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/common.sh"
V4_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$V4_ROOT"

for v in ETHERSCAN_API_KEY CHAIN_ID OWNER WETH POOL_MANAGER POSITION_MANAGER PERMIT2 UNIVERSAL_ROUTER BLOCK_DELAY; do
  require_env "$v"
done

for v in CLANKER_DEPLOYER_LIB CLANKER_ALLOWLIST CLANKER_FACTORY CLANKER_FEE_LOCKER CLANKER_LP_LOCKER CLANKER_HOOK CLANKER_MEV; do
  require_env "$v"
done

RETRIES="${VERIFY_RETRIES:-5}"
DELAY_SECONDS="${VERIFY_RETRY_DELAY_SECONDS:-4}"

run_verify() {
  local label="$1"
  shift

  local attempt=1
  while true; do
    set +e
    local output
    output="$($@ 2>&1)"
    local code=$?
    set -e

    if [[ $code -eq 0 ]]; then
      printf '%s\n' "$output"
      return 0
    fi

    if printf '%s' "$output" | grep -qi "already verified"; then
      printf '%s\n' "$output"
      return 0
    fi

    if printf '%s' "$output" | grep -Eqi "timeout|temporarily unavailable|429|network|ECONNRESET|ETIMEDOUT" && [[ "$attempt" -lt "$RETRIES" ]]; then
      echo "Verification network error for ${label} (attempt ${attempt}/${RETRIES}), retrying in ${DELAY_SECONDS}s..."
      sleep "$DELAY_SECONDS"
      attempt=$((attempt + 1))
      continue
    fi

    printf '%s\n' "$output" >&2
    return $code
  done
}

verify_contract() {
  local label="$1"
  local address="$2"
  local contract_path="$3"
  local constructor_args="${4:-}"

  echo "Verifying ${label}"
  if [[ -n "$constructor_args" ]]; then
    run_verify "$label" forge verify-contract \
      --chain-id "$CHAIN_ID" \
      --etherscan-api-key "$ETHERSCAN_API_KEY" \
      --constructor-args "$constructor_args" \
      "$address" \
      "$contract_path"
  else
    run_verify "$label" forge verify-contract \
      --chain-id "$CHAIN_ID" \
      --etherscan-api-key "$ETHERSCAN_API_KEY" \
      "$address" \
      "$contract_path"
  fi
}

ALLOWLIST_ARGS="$(cast abi-encode "constructor(address)" "$OWNER")"
CLANKER_ARGS="$(cast abi-encode "constructor(address)" "$OWNER")"
FEE_LOCKER_ARGS="$(cast abi-encode "constructor(address)" "$OWNER")"
LP_LOCKER_ARGS="$(cast abi-encode "constructor(address,address,address,address,address,address,address)" "$OWNER" "$CLANKER_FACTORY" "$CLANKER_FEE_LOCKER" "$POSITION_MANAGER" "$PERMIT2" "$UNIVERSAL_ROUTER" "$POOL_MANAGER")"
HOOK_ARGS="$(cast abi-encode "constructor(address,address,address,address)" "$POOL_MANAGER" "$CLANKER_FACTORY" "$CLANKER_ALLOWLIST" "$WETH")"
MEV_ARGS="$(cast abi-encode "constructor(uint256)" "$BLOCK_DELAY")"

verify_contract "ClankerDeployer" "$CLANKER_DEPLOYER_LIB" "src/utils/ClankerDeployer.sol:ClankerDeployer"
verify_contract "ClankerPoolExtensionAllowlist" "$CLANKER_ALLOWLIST" "src/hooks/ClankerPoolExtensionAllowlist.sol:ClankerPoolExtensionAllowlist" "$ALLOWLIST_ARGS"
verify_contract "Clanker" "$CLANKER_FACTORY" "src/Clanker.sol:Clanker" "$CLANKER_ARGS"
verify_contract "ClankerFeeLocker" "$CLANKER_FEE_LOCKER" "src/ClankerFeeLocker.sol:ClankerFeeLocker" "$FEE_LOCKER_ARGS"
verify_contract "ClankerLpLockerFeeConversion" "$CLANKER_LP_LOCKER" "src/lp-lockers/ClankerLpLockerFeeConversion.sol:ClankerLpLockerFeeConversion" "$LP_LOCKER_ARGS"
verify_contract "ClankerHookStaticFeeV2" "$CLANKER_HOOK" "src/hooks/ClankerHookStaticFeeV2.sol:ClankerHookStaticFeeV2" "$HOOK_ARGS"
verify_contract "ClankerMevBlockDelay" "$CLANKER_MEV" "src/mev-modules/ClankerMevBlockDelay.sol:ClankerMevBlockDelay" "$MEV_ARGS"

echo "Submitted verification requests"
