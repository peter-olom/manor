#!/usr/bin/env bash

set -euo pipefail

case "${MANOR_CODEX_AUTO_UPDATE:-0}" in
  1|true|TRUE|yes|YES|on|ON) ;;
  ""|0|false|FALSE|no|NO|off|OFF)
    exit 0
    ;;
  *)
    echo "MANOR_CODEX_AUTO_UPDATE must be one of: 1, true, yes, on, 0, false, no, off" >&2
    exit 64
    ;;
esac

target="${MANOR_CODEX_AUTO_UPDATE_VERSION:-latest}"
real_path="${MANOR_REAL_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
install_args=(--global)
strict="${MANOR_CODEX_AUTO_UPDATE_REQUIRED:-0}"

if [[ ! -w /usr/local/bin || ! -w /usr/local/lib/node_modules ]]; then
  install_prefix="${MANOR_CODEX_AUTO_UPDATE_PREFIX:-$HOME/.local}"
  mkdir -p "${install_prefix}/bin"
  install_args+=(--prefix "${install_prefix}")
else
  install_prefix=""
fi

echo "Updating Codex CLI to @openai/codex@${target} before startup..."
if ! PATH="${real_path}" npm install "${install_args[@]}" "@openai/codex@${target}"; then
  echo "Codex CLI auto-update failed." >&2
  case "${strict}" in
    1|true|TRUE|yes|YES|on|ON)
      exit 1
      ;;
    *)
      echo "Continuing with the existing Codex CLI." >&2
      codex --version || true
      exit 0
      ;;
  esac
fi

if [[ -n "${install_prefix}" ]]; then
  export PATH="${install_prefix}/bin:${PATH}"
fi

codex --version
