#!/usr/bin/env bash

set -euo pipefail

url="${1:-}"

if [[ -n "${url}" ]]; then
  printf '\nOpen this URL in your browser:\n%s\n\n' "${url}"
fi

exit 0
