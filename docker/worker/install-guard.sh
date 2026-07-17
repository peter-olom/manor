#!/usr/bin/env bash

set -euo pipefail

name="$(basename "$0")"
real_path="${MANOR_REAL_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

run_real() {
  PATH="${real_path}" exec "${name}" "$@"
}

is_help_or_version() {
  case "${1:-}" in
    -v|--version|version|help|--help)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
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

case "${name}" in
  npm|npx|pnpm|pnpx|yarn|yarnpkg|bun|bunx|pip|pip3|pipx|uv|uvx|poetry|bundle|composer|corepack|make|cmake|ctest|meson|ninja|gradle|mvn|ant|pytest|rspec|tsx|ts-node|jest|vitest)
    if is_help_or_version "${1:-}"; then
      run_real "$@"
    fi
    block
    ;;
  gem)
    case "${1:-}" in
      ""|-v|--version|version|help|--help|env|list|which)
        run_real "$@"
        ;;
      *)
        block
        ;;
    esac
    ;;
  cargo)
    case "${1:-}" in
      ""|-V|--version|version|help|--help|metadata|locate-project|tree|pkgid|read-manifest)
        run_real "$@"
        ;;
      *)
        block
        ;;
    esac
    ;;
  go)
    case "${1:-}" in
      ""|version|env|help|fmt|vet|list)
        run_real "$@"
        ;;
      *)
        block
        ;;
    esac
    ;;
  apt|apt-get)
    case "${1:-}" in
      ""|-v|--version|help)
        run_real "$@"
        ;;
      list|show|search|policy)
        run_real "$@"
        ;;
      *)
        block
        ;;
    esac
    ;;
  apk)
    case "${1:-}" in
      ""|-v|--version|help|info|search|policy)
        run_real "$@"
        ;;
      add|del|upgrade|fix)
        block
        ;;
      *)
        block
        ;;
    esac
    ;;
  dnf|yum)
    case "${1:-}" in
      ""|-v|--version|help|info|list|search|repolist)
        run_real "$@"
        ;;
      install|reinstall|remove|upgrade|update|groupinstall|module)
        block
        ;;
      *)
        block
        ;;
    esac
    ;;
  brew)
    case "${1:-}" in
      ""|-v|--version|help|--help|config|doctor|info|list|search)
        run_real "$@"
        ;;
      install|upgrade|reinstall|tap|untap|bundle|services|link|unlink|postinstall)
        block
        ;;
      *)
        block
        ;;
    esac
    ;;
  playwright)
    case "${1:-}" in
      ""|-V|--version|version|help|--help)
        run_real "$@"
        ;;
      install|install-deps|uninstall)
        block
        ;;
      *)
        block
        ;;
    esac
    ;;
  mise)
    case "${1:-}" in
      ""|-V|--version|version|help|--help|current|doctor|env|info|ls|list|where|which)
        run_real "$@"
        ;;
      *)
        block
        ;;
    esac
    ;;
  *)
    block
    ;;
esac
