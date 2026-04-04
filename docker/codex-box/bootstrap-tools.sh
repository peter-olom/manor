#!/usr/bin/env bash

set -euo pipefail

mkdir -p "${HOME}/.local/bin" "${HOME}/.local/share/mise"

if command -v fdfind >/dev/null 2>&1 && [[ ! -e "${HOME}/.local/bin/fd" ]]; then
  ln -s "$(command -v fdfind)" "${HOME}/.local/bin/fd"
fi

if command -v python3 >/dev/null 2>&1 && [[ ! -e "${HOME}/.local/bin/python" ]]; then
  ln -s "$(command -v python3)" "${HOME}/.local/bin/python"
fi

if command -v mise >/dev/null 2>&1; then
  mise settings set disable_hints true >/dev/null 2>&1 || true
  mise settings set status.missing_tools never >/dev/null 2>&1 || true
fi
