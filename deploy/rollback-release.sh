#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <release-id>" >&2
  exit 64
fi

release_root="${PUBLISH_RELAY_RELEASE_ROOT:-/opt/publish-relay/releases}"
current_link="${PUBLISH_RELAY_CURRENT_LINK:-/opt/publish-relay/current}"
health_url="${PUBLISH_RELAY_HEALTH_URL:-http://127.0.0.1:3106/health/ready}"
release_directory="${release_root}/$1"
[[ -d "$release_directory" ]] || { echo "release does not exist" >&2; exit 66; }
ln -sfn "$release_directory" "${current_link}.next"
mv -Tf "${current_link}.next" "$current_link"
systemctl restart publish-relay-web publish-relay-worker
systemctl is-active --quiet publish-relay-web publish-relay-worker
curl --fail --silent --show-error "$health_url" >/dev/null
