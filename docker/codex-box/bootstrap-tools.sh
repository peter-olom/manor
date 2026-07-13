#!/usr/bin/env bash

set -euo pipefail

mkdir -p "${HOME}/.local/bin" "${HOME}/.local/share/mise"

if command -v fdfind >/dev/null 2>&1 && [[ ! -e "${HOME}/.local/bin/fd" ]]; then
  ln -s "$(command -v fdfind)" "${HOME}/.local/bin/fd"
fi

if [[ -x /usr/bin/python3 && ! -e "${HOME}/.local/bin/python" ]]; then
  ln -s /usr/bin/python3 "${HOME}/.local/bin/python"
fi
