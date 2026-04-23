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
${name} is blocked in the shared Codex box.
Do repo and git work here.
Use a Manor preview for package installs, app startup, builds, and project execution.
EOF
  exit 126
}

case "${name}" in
  npm|npx|pnpm|pnpx|yarn|yarnpkg|bun|bunx|pip|pip3|pipx|uv|uvx|poetry|bundle|composer|corepack)
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
      install|update|uninstall|pristine|cleanup|setup|sources)
        block
        ;;
      *)
        run_real "$@"
        ;;
    esac
    ;;
  cargo)
    case "${1:-}" in
      ""|-V|--version|version|help|--help|fmt|clippy|metadata|locate-project|tree|pkgid|read-manifest)
        run_real "$@"
        ;;
      install|add|remove|update|fetch|vendor)
        block
        ;;
      *)
        run_real "$@"
        ;;
    esac
    ;;
  go)
    case "${1:-}" in
      ""|version|env|help|fmt|vet|list)
        run_real "$@"
        ;;
      get|install)
        block
        ;;
      *)
        run_real "$@"
        ;;
    esac
    ;;
  apt|apt-get)
    case "${1:-}" in
      ""|-v|--version|help)
        run_real "$@"
        ;;
      install|remove|purge|upgrade|dist-upgrade|full-upgrade|autoremove|build-dep|source|download)
        block
        ;;
      *)
        run_real "$@"
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
        run_real "$@"
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
        run_real "$@"
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
        run_real "$@"
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
        run_real "$@"
        ;;
    esac
    ;;
  *)
    block
    ;;
esac
