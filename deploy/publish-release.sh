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
health_attempts="${PUBLISH_RELAY_HEALTH_ATTEMPTS:-12}"
health_interval_seconds="${PUBLISH_RELAY_HEALTH_INTERVAL_SECONDS:-2}"
: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required}"

[[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "invalid release id" >&2; exit 64; }
[[ -f "${source_directory}/package-lock.json" ]] || { echo "source directory is not a release" >&2; exit 66; }
[[ -f "${source_directory}/dist/database/migrate.js" ]] || { echo "compiled migration entrypoint is missing" >&2; exit 66; }
[[ ! -e "$release_directory" ]] || { echo "release already exists" >&2; exit 73; }
[[ -x "$node_bin" ]] || { echo "Node 24 executable is missing: $node_bin" >&2; exit 69; }
[[ -f "$npm_cli" ]] || { echo "Node 24 npm CLI is missing: $npm_cli" >&2; exit 69; }
[[ -x "$psql_bin" ]] || { echo "PostgreSQL client is missing: $psql_bin" >&2; exit 69; }
[[ "$($node_bin --version)" =~ ^v24\. ]] || { echo "selected Node executable is not Node 24" >&2; exit 69; }
[[ "$health_attempts" =~ ^[1-9][0-9]*$ ]] || { echo "health attempts must be a positive integer" >&2; exit 64; }
[[ "$health_interval_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "health interval must be a non-negative number" >&2; exit 64; }

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$script_directory/release-lifecycle.sh"
[[ -d "$release_root" && ! -L "$release_root" ]] || { echo "Provision a real empty releases directory first" >&2; exit 66; }
lifecycle_begin
if [[ -n "${PUBLISH_RELAY_MIGRATION_TRANSITION:-}" ]]; then
  export PUBLISH_RELAY_MIGRATION_SOURCE="$previous_release"
fi
candidate_created=true
install -d -o "$service_user" -g "$service_user" "$release_directory"
cp -a "${source_directory}/." "$release_directory/"
chown -R "${service_user}:${service_user}" "$release_directory"

sudo -u "$service_user" "$node_bin" "$npm_cli" ci --omit=dev --ignore-scripts --prefix "$release_directory"
# npm owns the dependency install and may remove build output from the candidate tree.
# Restore the already-reviewed artifact from the release source; production never builds it.
if [[ -e "${release_directory}/dist" || -L "${release_directory}/dist" ]]; then
  rm -rf -- "${release_directory}/dist"
fi
cp -a "${source_directory}/dist" "${release_directory}/dist"
# Runtime may read release code, but must not mutate an old tree during cleanup checks.
chown -hR "$(id -un):${service_user}" "$release_directory"
chmod -R u=rwX,g=rX,o= "$release_directory"
sudo -u "$service_user" test -r "${release_directory}/dist/database/migrate.js" || {
  echo "compiled migration entrypoint is not readable by service user" >&2
  exit 66
}
lifecycle_guard artifact "$release_root" "$current_link" "$release_id"
(
  cd "$release_directory"
  migration_environment=DATABASE_URL,PGPASSWORD
  if [[ -n "${PUBLISH_RELAY_MIGRATION_TRANSITION:-}" ]]; then
    migration_environment+=,PUBLISH_RELAY_MIGRATION_TRANSITION,PUBLISH_RELAY_MIGRATION_SOURCE
  fi
  DATABASE_URL="$MIGRATION_DATABASE_URL" PGPASSWORD="${PGPASSWORD:-}" \
    sudo --preserve-env="$migration_environment" \
    -u "$service_user" "$node_bin" dist/database/migrate.js
  PGPASSWORD="${PGPASSWORD:-}" \
    sudo --preserve-env=PGPASSWORD \
    -u "$service_user" "$psql_bin" -v ON_ERROR_STOP=1 \
    -f deploy/bootstrap-database-authorities.sql "$MIGRATION_DATABASE_URL"
)
switch_started=true
lifecycle_switch "$release_directory" "$previous_release"
systemctl restart publish-relay-web publish-relay-worker
lifecycle_smoke "$release_directory"
# Successful smoke commits the candidate; cleanup failure must not revert healthy code.
deployment_committed=true
if [[ -n "$previous_release" ]]; then
  lifecycle_guard remove "$release_root" "$current_link" "$release_directory" "${previous_release##*/}" || {
    echo "Old release cleanup blocked; preserve deployment lock for owner recovery" >&2
    trap - EXIT
    exit 1
  }
fi
