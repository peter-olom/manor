#!/usr/bin/env bash

set -euo pipefail

real_git=/usr/bin/git
hook=/opt/manor/worker/dist/server/content-admission-git-hook.js
args=("$@")
command_name=""
command_index=-1
git_cwd="$(pwd)"
skip_next=0
for index in "${!args[@]}"; do
  argument="${args[$index]}"
  if (( skip_next )); then skip_next=0; continue; fi
  if [[ "${argument}" == "-C" ]]; then git_cwd="${args[$((index + 1))]}"; skip_next=1; continue; fi
  if [[ "${argument}" == "-c" || "${argument}" == "--git-dir" || "${argument}" == "--work-tree" ]]; then skip_next=1; continue; fi
  if [[ "${argument}" == -* ]]; then continue; fi
  command_name="${argument}"
  command_index="${index}"
  break
done

subcommand=""
if (( command_index >= 0 && command_index + 1 < ${#args[@]} )); then
  for ((index = command_index + 1; index < ${#args[@]}; index++)); do
    if [[ "${args[$index]}" != -* ]]; then subcommand="${args[$index]}"; break; fi
  done
fi

before_refs="$(mktemp -t manor-git-before.XXXXXX)"
trap 'rm -f "${before_refs}"' EXIT
if "${real_git}" -C "${git_cwd}" rev-parse --git-dir >/dev/null 2>&1; then
  {
    "${real_git}" -C "${git_cwd}" for-each-ref --format='%(objectname)'
    "${real_git}" -C "${git_cwd}" rev-parse HEAD 2>/dev/null || true
  } >"${before_refs}"
fi

"${real_git}" "$@"

review_paths=()
case "${command_name}" in
  clone)
    destination="${args[-1]}"
    if [[ "${destination}" == *"://"* || "${destination}" == *"@"*:* || "${destination}" == *.git ]]; then
      destination="$(basename "${destination}" .git)"
    fi
    review_path="$(cd "${git_cwd}/${destination}" 2>/dev/null && pwd || true)"
    [[ -n "${review_path}" ]] && review_paths+=("${review_path}")
    ;;
  fetch|pull|checkout|switch|merge|rebase|reset|restore|cherry-pick)
    review_path="$(cd "${git_cwd}" 2>/dev/null && pwd || true)"
    [[ -n "${review_path}" ]] && review_paths+=("${review_path}")
    ;;
  worktree)
    if [[ "${subcommand}" == "add" ]]; then
      while IFS= read -r review_path; do [[ -n "${review_path}" ]] && review_paths+=("${review_path}"); done < <("${real_git}" -C "${git_cwd}" worktree list --porcelain | sed -n 's/^worktree //p')
    fi
    ;;
  submodule)
    if [[ "${subcommand}" == "update" ]]; then
      review_paths+=("$(cd "${git_cwd}" && pwd)")
      while IFS= read -r review_path; do [[ -n "${review_path}" ]] && review_paths+=("${review_path}"); done < <("${real_git}" -C "${git_cwd}" submodule foreach --recursive --quiet 'pwd' 2>/dev/null || true)
    fi
    ;;
  lfs)
    if [[ "${subcommand}" == "fetch" || "${subcommand}" == "pull" || "${subcommand}" == "checkout" ]]; then
      review_path="$(cd "${git_cwd}" 2>/dev/null && pwd || true)"
      [[ -n "${review_path}" ]] && review_paths+=("${review_path}")
    fi
    ;;
  *)
    exit 0
    ;;
esac

for review_path in "${review_paths[@]}"; do
  /usr/local/bin/node "${hook}" "${review_path}" "${before_refs}" "git ${command_name}${subcommand:+ ${subcommand}}"
done
