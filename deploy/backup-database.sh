#!/usr/bin/env bash
set -euo pipefail
umask 077

mode=encrypted
if [[ $# -eq 1 && "$1" == --local ]]; then
  mode=local
elif [[ $# -ne 0 ]]; then
  echo "usage: $0 [--local]" >&2
  exit 64
fi
: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required}"
if [[ "$mode" == encrypted ]]; then
  : "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"
fi
backup_directory="${BACKUP_DIRECTORY:-/var/backups/publish-relay}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_directory}/publish-relay-${timestamp}.dump"
if [[ "$mode" == encrypted ]]; then target="${target}.age"; fi

[[ ! -L "$backup_directory" ]] || { echo "backup root must not be a symlink" >&2; exit 65; }
install -d -m 0700 "$backup_directory"
stage="$(mktemp -d "${backup_directory}/.capture-XXXXXXXX")"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
pg_dump --format=custom --no-owner --no-acl "$MIGRATION_DATABASE_URL" > "$stage/backup.dump"
[[ -s "$stage/backup.dump" ]] || { echo "empty database backup refused" >&2; exit 65; }
pg_restore --no-owner --no-acl --file=/dev/null "$stage/backup.dump"
if [[ "$mode" == encrypted ]]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$stage/backup.dump.age" "$stage/backup.dump"
  mv "$stage/backup.dump.age" "$target"
else
  mv "$stage/backup.dump" "$target"
fi
echo "$target"
