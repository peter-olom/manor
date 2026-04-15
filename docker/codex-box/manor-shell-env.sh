#!/usr/bin/env bash

set -euo pipefail

guard_bin="/opt/manor/codex-box/install-guard-bin"

if [[ -n "${MANOR_REAL_PATH:-}" ]]; then
  export PATH="${guard_bin}:${MANOR_REAL_PATH}"
elif [[ ":${PATH}:" != *":${guard_bin}:"* ]]; then
  export PATH="${guard_bin}:${PATH}"
fi
