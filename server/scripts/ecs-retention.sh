#!/usr/bin/env bash
set -Eeuo pipefail

dry_run=0
keep_backups="${BOBBO_KEEP_BACKUPS:-3}"
keep_images="${BOBBO_KEEP_IMAGES:-3}"
backup_root="${BOBBO_BACKUP_ROOT:-/opt/bobbo/backups}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --keep-backups) shift; keep_backups="${1:?missing backup count}" ;;
    --keep-images) shift; keep_images="${1:?missing image count}" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[[ "$keep_backups" =~ ^[0-9]+$ ]] || { echo 'invalid backup retention count' >&2; exit 2; }
[[ "$keep_images" =~ ^[0-9]+$ ]] || { echo 'invalid image retention count' >&2; exit 2; }

backup_root_abs="$(realpath -m -- "$backup_root")"
[[ "$backup_root_abs" == '/opt/bobbo/backups' ]] || {
  echo "refusing unexpected backup root: $backup_root_abs" >&2
  exit 1
}

run_remove_backup() {
  local candidate_abs
  candidate_abs="$(realpath -m -- "$1")"
  [[ "$candidate_abs" == "$backup_root_abs/"* ]] || {
    echo "refusing backup outside root: $candidate_abs" >&2
    exit 1
  }
  if [[ "$dry_run" -eq 1 ]]; then
    echo "DRY_RUN remove-backup $candidate_abs"
  else
    rm -rf -- "$candidate_abs"
    echo "removed-backup $candidate_abs"
  fi
}

mapfile -t backup_entries < <(
  find "$backup_root_abs" -mindepth 1 -maxdepth 1 -printf '%T@|%p\n' \
    | sort -t '|' -k1,1nr \
    | cut -d '|' -f 2-
)
for ((index=keep_backups; index<${#backup_entries[@]}; index++)); do
  run_remove_backup "${backup_entries[$index]}"
done

declare -A container_image_ids=()
while IFS= read -r container_id; do
  [[ -n "$container_id" ]] || continue
  container_image_ids["$(docker container inspect --format '{{.Image}}' "$container_id")"]=1
done < <(docker ps -aq)

prune_image_family() {
  local repository="$1"
  local -a rows=()
  local -A seen_refs=()
  local -A retained_refs=()
  local image_ref short_id full_id created row protected_count=0 retained_count=0

  while IFS='|' read -r image_ref short_id; do
    [[ -n "$image_ref" && "$image_ref" != '<none>:<none>' ]] || continue
    [[ -z "${seen_refs[$image_ref]:-}" ]] || continue
    seen_refs[$image_ref]=1
    full_id="$(docker image inspect --format '{{.Id}}' "$short_id")"
    created="$(docker image inspect --format '{{.Created}}' "$full_id")"
    rows+=("$created|$full_id|$image_ref")
  done < <(docker image ls "$repository" --format '{{.Repository}}:{{.Tag}}|{{.ID}}')

  mapfile -t rows < <(printf '%s\n' "${rows[@]}" | sed '/^$/d' | sort -r)
  for row in "${rows[@]}"; do
    full_id="${row#*|}"
    full_id="${full_id%%|*}"
    image_ref="${row##*|}"
    if [[ -n "${container_image_ids[$full_id]:-}" ]]; then
      retained_refs[$image_ref]=1
      ((protected_count+=1))
    fi
  done

  retained_count="$protected_count"
  for row in "${rows[@]}"; do
    image_ref="${row##*|}"
    if [[ -n "${retained_refs[$image_ref]:-}" ]]; then
      continue
    fi
    if (( retained_count < keep_images )); then
      retained_refs[$image_ref]=1
      ((retained_count+=1))
    fi
  done

  for row in "${rows[@]}"; do
    full_id="${row#*|}"
    full_id="${full_id%%|*}"
    image_ref="${row##*|}"
    [[ -z "${retained_refs[$image_ref]:-}" ]] || continue
    if [[ "$dry_run" -eq 1 ]]; then
      echo "DRY_RUN remove-image $repository $image_ref $full_id"
    else
      docker image rm "$image_ref" >/dev/null
      echo "removed-image $repository $image_ref $full_id"
    fi
  done
}

prune_image_family bobbo-backend
prune_image_family bobbo-prelaunch
