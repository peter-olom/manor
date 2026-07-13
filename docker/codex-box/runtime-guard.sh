#!/usr/bin/env bash

set -euo pipefail

name="$(basename "$0")"
real_path="${MANOR_REAL_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

case "${1:-}" in
  -v|-V|--version|version|-h|--help|help)
    PATH="${real_path}" exec "${name}" "$@"
    ;;
esac

cat >&2 <<EOF
RUN_IN_PREVIEW
${name} is blocked in the shared Worker execution host.
The Worker shell is only for source files, repository inspection, editing, and Git.
Run package installs, builds, tests, scripts, servers, conversions, and project code in a Manor preview.
EOF
exit 126
