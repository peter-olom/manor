#!/usr/bin/env bash

set -euo pipefail

source_dir="${1:?source directory is required}"
clean_head="${2:-}"

hash_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    openssl dgst -sha256 | awk '{print $NF}'
  fi
}

empty_hash="$(printf '' | hash_stdin)"
tracked_hash="${empty_hash}"
untracked_hash="${empty_hash}"

if [[ -n "${clean_head}" ]]; then
  head_sha="${clean_head}"
  dirty="false"
else
  head_sha="$(git -C "${source_dir}" rev-parse HEAD)"
  tracked_hash="$(git -C "${source_dir}" diff --binary --no-ext-diff HEAD -- | hash_stdin)"

  untracked_manifest="$(mktemp)"
  trap 'rm -f -- "${untracked_manifest}"' EXIT
  while IFS= read -r -d '' relative_path; do
    absolute_path="${source_dir}/${relative_path}"
    if [[ -L "${absolute_path}" ]]; then
      kind="symlink"
      content_hash="$(readlink "${absolute_path}" | hash_stdin)"
    elif [[ -x "${absolute_path}" ]]; then
      kind="executable"
      content_hash="$(hash_stdin < "${absolute_path}")"
    else
      kind="file"
      content_hash="$(hash_stdin < "${absolute_path}")"
    fi
    printf '%s\0%s\0%s\0' "${relative_path}" "${kind}" "${content_hash}" >> "${untracked_manifest}"
  done < <(git -C "${source_dir}" ls-files --others --exclude-standard -z)
  untracked_hash="$(hash_stdin < "${untracked_manifest}")"

  if [[ -n "$(git -C "${source_dir}" status --porcelain --untracked-files=normal)" ]]; then
    dirty="true"
  else
    dirty="false"
  fi
fi

fingerprint="$({
  printf 'manor-source-v1\0'
  printf 'head\0%s\0' "${head_sha}"
  printf 'tracked\0%s\0' "${tracked_hash}"
  printf 'untracked\0%s\0' "${untracked_hash}"
} | hash_stdin)"

printf '%s\t%s\t%s\n' "${head_sha}" "${dirty}" "${fingerprint}"
