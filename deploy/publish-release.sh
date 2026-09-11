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
node_bin="${PUBLISH_RELAY_NODE_BIN:-/opt/publish-relay/node24/bin/node}"
npm_cli="${PUBLISH_RELAY_NPM_CLI:-/opt/publish-relay/node24/lib/node_modules/npm/bin/npm-cli.js}"
psql_bin="${PUBLISH_RELAY_PSQL_BIN:-/usr/bin/psql}"
health_url="${PUBLISH_RELAY_HEALTH_URL:-http://127.0.0.1:3106/health/ready}"
: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required}"

[[ "$release_id" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid release id" >&2; exit 64; }
[[ -f "${source_directory}/package-lock.json" ]] || { echo "source directory is not a release" >&2; exit 66; }
[[ -f "${source_directory}/dist/database/migrate.js" ]] || { echo "compiled migration entrypoint is missing" >&2; exit 66; }
[[ ! -e "$release_directory" ]] || { echo "release already exists" >&2; exit 73; }
[[ -x "$node_bin" ]] || { echo "Node 24 executable is missing: $node_bin" >&2; exit 69; }
[[ -f "$npm_cli" ]] || { echo "Node 24 npm CLI is missing: $npm_cli" >&2; exit 69; }
[[ -x "$psql_bin" ]] || { echo "PostgreSQL client is missing: $psql_bin" >&2; exit 69; }
[[ "$($node_bin --version)" =~ ^v24\. ]] || { echo "selected Node executable is not Node 24" >&2; exit 69; }

install -d -o "$service_user" -g "$service_user" "$release_root"
install -d -o "$service_user" -g "$service_user" "$release_directory"
cp -a "${source_directory}/." "$release_directory/"
chown -R "${service_user}:${service_user}" "$release_directory"

sudo -u "$service_user" "$node_bin" "$npm_cli" ci --omit=dev --ignore-scripts --prefix "$release_directory"
(
  cd "$release_directory"
  DATABASE_URL="$MIGRATION_DATABASE_URL" PGPASSWORD="${PGPASSWORD:-}" \
    sudo --preserve-env=DATABASE_URL,PGPASSWORD \
    -u "$service_user" "$node_bin" dist/database/migrate.js
  PGDATABASE="$MIGRATION_DATABASE_URL" PGPASSWORD="${PGPASSWORD:-}" \
    sudo --preserve-env=PGDATABASE,PGPASSWORD \
    -u "$service_user" "$psql_bin" -v ON_ERROR_STOP=1 \
    -f deploy/bootstrap-database-authorities.sql
)
ln -sfn "$release_directory" "${current_link}.next"
mv -Tf "${current_link}.next" "$current_link"
systemctl restart publish-relay-web publish-relay-worker
systemctl is-active --quiet publish-relay-web publish-relay-worker
curl --fail --silent --show-error "$health_url" >/dev/null
