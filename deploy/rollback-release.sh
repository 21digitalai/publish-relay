#!/usr/bin/env bash
set -euo pipefail
# PUBLISH_RELAY_HEALTH_URL defaults to http://127.0.0.1:3106/health/ready in publish-release.
# Old code is rebuilt from the approved Git commit, not retained on the VPS.
if [[ $# -ne 2 ]]; then
  echo "usage: $0 <new-release-id> <rebuilt-source-directory>" >&2
  exit 64
fi
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$script_directory/publish-release.sh" "$@"
