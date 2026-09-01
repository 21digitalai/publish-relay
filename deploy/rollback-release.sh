#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <release-id>" >&2
  exit 64
fi

release_directory="/opt/publish-relay/releases/$1"
[[ -d "$release_directory" ]] || { echo "release does not exist" >&2; exit 66; }
ln -sfn "$release_directory" /opt/publish-relay/current.next
mv -Tf /opt/publish-relay/current.next /opt/publish-relay/current
systemctl restart publish-relay-web publish-relay-worker
systemctl is-active --quiet publish-relay-web publish-relay-worker
curl --fail --silent --show-error http://127.0.0.1:3100/health/ready >/dev/null
