#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"
backup_directory="${BACKUP_DIRECTORY:-/var/backups/publish-relay}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_directory}/publish-relay-${timestamp}.dump.age"

install -d -m 0700 "$backup_directory"
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" | age -r "$BACKUP_AGE_RECIPIENT" -o "${target}.tmp"
mv "${target}.tmp" "$target"
find "$backup_directory" -type f -name 'publish-relay-*.dump.age' -mtime +14 -delete
echo "$target"
