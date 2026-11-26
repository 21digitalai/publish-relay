#!/usr/bin/env bash
# Backup/restore gate for the existing standalone activation transaction.
set -euo pipefail
[[ $# -eq 2 ]] || { echo "usage: $0 <release-id> <checked-candidate>" >&2; exit 64; }
[[ "$(uname -s)" == Linux ]] || { echo "Only Linux/systemd standalone updates are supported" >&2; exit 69; }
: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required}"
: "${RESTORE_DATABASE_URL:?isolated RESTORE_DATABASE_URL is required}"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
node_bin="${PUBLISH_RELAY_NODE_BIN:-/opt/publish-relay/node24/bin/node}"
psql_bin="${PUBLISH_RELAY_PSQL_BIN:-/usr/bin/psql}"
release_root="${PUBLISH_RELAY_RELEASE_ROOT:-/opt/publish-relay/releases}"
current_link="${PUBLISH_RELAY_CURRENT_LINK:-/opt/publish-relay/current}"
for command in systemctl sudo lsof curl pg_dump pg_restore; do command -v "$command" >/dev/null; done
[[ "$("$node_bin" --version)" =~ ^v24\. ]] || { echo "Node24 required" >&2; exit 69; }
"$node_bin" "$script_directory/release-filesystem.mjs" preflight "$release_root" "$current_link" "$1" "$2" >/dev/null
backup_path="$(bash "$script_directory/backup-database.sh" --local)"
bash "$script_directory/restore-drill.sh" "$backup_path"
"$psql_bin" "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$script_directory/bootstrap-database-authorities.sql"
echo "Backup and isolated restore verified: $backup_path"
exec bash "$script_directory/publish-release.sh" "$@"
