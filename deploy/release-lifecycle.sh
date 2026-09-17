#!/usr/bin/env bash
# Shared serialized one-release transaction. Sourced only by publish-release.sh.
lifecycle_guard() { "$node_bin" "$script_directory/release-filesystem.mjs" "$@"; }

lifecycle_switch() {
  lifecycle_guard selection "$release_root" "$current_link" "$2" || return 1
  [[ ! -e "${current_link}.next" && ! -L "${current_link}.next" ]] || return 1
  ln -s "$1" "${current_link}.next"
  mv -Tf "${current_link}.next" "$current_link"
}

lifecycle_smoke() {
  systemctl is-active --quiet publish-relay-web publish-relay-worker || return 1
  for ((health_attempt = 1; health_attempt <= health_attempts; health_attempt += 1)); do
    if curl --fail --silent --show-error --connect-timeout 5 --max-time 10 "$health_url" >/dev/null; then
      lifecycle_guard verify "$release_root" "$current_link" "$1"
      return $?
    fi
    if ((health_attempt < health_attempts)); then sleep "$health_interval_seconds"; fi
  done
  echo "readiness probe failed after ${health_attempts} attempts: ${health_url}" >&2
  return 7
}

lifecycle_finish() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$deployment_committed" != true && "$candidate_created" == true ]]; then
    if [[ "$switch_started" == true ]]; then
      if [[ -n "$previous_release" ]]; then
        if ! lifecycle_switch "$previous_release" "$release_directory" ||
           ! systemctl restart publish-relay-web publish-relay-worker ||
           ! lifecycle_smoke "$previous_release"; then
          echo "Recovery failed; preserve both releases and deployment lock for owner recovery" >&2
          exit 1
        fi
      else
        if ! systemctl stop publish-relay-web publish-relay-worker; then exit 1; fi
        if [[ "$(readlink "$current_link")" != "$release_directory" ]]; then exit 1; fi
        rm "$current_link"
      fi
    fi
    # Partial copy without its marker stays locked rather than guessing.
    if ! lifecycle_guard remove "$release_root" "$current_link" "$previous_release" "$release_id"; then
      echo "Candidate cleanup blocked; preserve deployment lock for owner recovery" >&2
      exit 1
    fi
  fi
  rmdir "$deployment_lock"
  exit "$status"
}

lifecycle_begin() {
  lifecycle_guard root "$release_root" "$current_link"
  command -v lsof >/dev/null || { echo "lsof is required for safe cleanup" >&2; exit 69; }
  [[ ! -e "${current_link}.next" && ! -L "${current_link}.next" ]] || {
    echo "Interrupted current switch requires owner recovery" >&2; exit 75;
  }
  deployment_lock="${release_root%/releases}/.deployment-lock"
  mkdir "$deployment_lock" || { echo "Deployment busy or requires recovery" >&2; exit 75; }
  candidate_created=false
  switch_started=false
  deployment_committed=false
  previous_release=""
  trap lifecycle_finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  previous_release="$(lifecycle_guard preflight "$release_root" "$current_link" "$release_id" "$source_directory")"
}
