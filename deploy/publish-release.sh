#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <release-id> <source-directory>" >&2
  exit 64
fi

release_id="$1"
source_directory="$2"
release_root="/opt/publish-relay/releases"
release_directory="${release_root}/${release_id}"
current_link="/opt/publish-relay/current"

[[ "$release_id" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid release id" >&2; exit 64; }
[[ -f "${source_directory}/package-lock.json" ]] || { echo "source directory is not a release" >&2; exit 66; }
[[ ! -e "$release_directory" ]] || { echo "release already exists" >&2; exit 73; }

install -d -o publish-relay -g publish-relay "$release_root"
install -d -o publish-relay -g publish-relay "$release_directory"
cp -a "${source_directory}/." "$release_directory/"
chown -R publish-relay:publish-relay "$release_directory"

sudo -u publish-relay npm ci --omit=dev --ignore-scripts --prefix "$release_directory"
sudo -u publish-relay npm run db:migrate --prefix "$release_directory"
ln -sfn "$release_directory" "${current_link}.next"
mv -Tf "${current_link}.next" "$current_link"
systemctl restart publish-relay-web publish-relay-worker
systemctl is-active --quiet publish-relay-web publish-relay-worker
curl --fail --silent --show-error http://127.0.0.1:3100/health/ready >/dev/null
