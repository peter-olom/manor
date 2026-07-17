#!/usr/bin/env bash

set -euo pipefail

name="$(basename "$0")"

run_real() {
  local target=""
  case "${name}" in
    python3)
      if [[ -x /usr/local/bin/python3 ]]; then
        target=/usr/local/bin/python3
      elif [[ -x /usr/bin/python3 ]]; then
        target=/usr/bin/python3
      fi
      ;;
    *)
      if [[ -x /usr/local/bin/python ]]; then
        target=/usr/local/bin/python
      elif [[ -x /usr/bin/python ]]; then
        target=/usr/bin/python
      elif [[ -x /usr/bin/python3 ]]; then
        target=/usr/bin/python3
      fi
      ;;
  esac

  if [[ -z "${target}" ]]; then
    echo "Unable to find the real ${name} interpreter." >&2
    exit 127
  fi

  exec "${target}" "$@"
}

block() {
  cat >&2 <<EOF
RUN_IN_PREVIEW
${name} is blocked in the shared Worker execution host.
The Worker shell is only for source files, repository inspection, editing, and Git.
Run package installs, builds, tests, scripts, servers, conversions, and project code in a Manor preview.
EOF
  exit 126
}

case "${1:-}" in
  ""|-V|--version|-h|--help)
    run_real "$@"
    ;;
  *)
    block
    ;;
esac
