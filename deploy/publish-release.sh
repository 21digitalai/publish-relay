#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <release-id> <source-directory>" >&2
  exit 64
fi

release_id="$1"
source_directory="$2"
release_root="${PUBLISH_RELAY_RELEASE_ROOT:-/opt/publish-relay/releases}"
release_directory="${release_root}/${release_id}"
current_link="${PUBLISH_RELAY_CURRENT_LINK:-/opt/publish-relay/current}"
service_user="${PUBLISH_RELAY_SERVICE_USER:-publish-relay}"

[[ "$release_id" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid release id" >&2; exit 64; }
[[ -f "${source_directory}/package-lock.json" ]] || { echo "source directory is not a release" >&2; exit 66; }
[[ -f "${source_directory}/dist/database/migrate.js" ]] || { echo "compiled migration entrypoint is missing" >&2; exit 66; }
[[ ! -e "$release_directory" ]] || { echo "release already exists" >&2; exit 73; }

install -d -o "$service_user" -g "$service_user" "$release_root"
install -d -o "$service_user" -g "$service_user" "$release_directory"
cp -a "${source_directory}/." "$release_directory/"
chown -R "${service_user}:${service_user}" "$release_directory"

sudo -u "$service_user" npm ci --omit=dev --ignore-scripts --prefix "$release_directory"
sudo -u "$service_user" npm run db:migrate:production --prefix "$release_directory"
ln -sfn "$release_directory" "${current_link}.next"
mv -Tf "${current_link}.next" "$current_link"
systemctl restart publish-relay-web publish-relay-worker
systemctl is-active --quiet publish-relay-web publish-relay-worker
curl --fail --silent --show-error http://127.0.0.1:3100/health/ready >/dev/null
