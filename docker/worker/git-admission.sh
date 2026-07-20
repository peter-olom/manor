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
    destination="${args[$((${#args[@]} - 1))]}"
    if [[ "${destination}" == *"://"* || "${destination}" == *"@"*:* || "${destination}" == *.git ]]; then
      destination="$(basename "${destination}" .git)"
    fi
    if [[ "${destination}" == /* ]]; then review_target="${destination}"; else review_target="${git_cwd}/${destination}"; fi
    review_path="$(cd "${review_target}" 2>/dev/null && pwd || true)"
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

if (( ${#review_paths[@]} == 0 )); then exit 0; fi

admission_batch="$(mktemp -t manor-git-admission-batch.XXXXXX)"
admission_status=0
for review_path in "${review_paths[@]}"; do
  admission_output="$(mktemp -t manor-git-admission.XXXXXX)"
  set +e
  /usr/local/bin/node "${hook}" "${review_path}" "${before_refs}" "git ${command_name}${subcommand:+ ${subcommand}}" >"${admission_output}" 2>&1
  current_status=$?
  set -e
  while IFS= read -r line || [[ -n "${line}" ]]; do
    printf '%s\n' "${line}" >>"${admission_batch}"
  done <"${admission_output}"
  rm -f "${admission_output}"
  if (( current_status != 0 && admission_status == 0 )); then admission_status="${current_status}"; fi
done

frame_nonce="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
printf '\nMANOR_GIT_CONTROL_BEGIN %s\n' "${frame_nonce}" >&2
while IFS= read -r line || [[ -n "${line}" ]]; do
  printf '%s\n' "${line}" >&2
done <"${admission_batch}"
printf 'MANOR_GIT_CONTROL_END %s\n' "${frame_nonce}" >&2
rm -f "${admission_batch}"

if (( admission_status != 0 )); then exit "${admission_status}"; fi
