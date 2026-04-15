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
${name} is blocked from package installation in the shared Codex box.
Use a Manor preview for dependency installs and project execution.
EOF
  exit 126
}

if [[ "${1:-}" == "-m" ]]; then
  module="${2:-}"
  subcommand="${3:-}"
  case "${module}" in
    pip|pip3|ensurepip|uv|piptools|pipx|poetry)
      block
      ;;
    playwright)
      case "${subcommand}" in
        install|install-deps|uninstall)
          block
          ;;
      esac
      ;;
  esac
fi

run_real "$@"
