#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <encrypted-backup>" >&2
  exit 64
fi
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
: "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY is required}"

age -d -i "$BACKUP_AGE_IDENTITY" "$1" | pg_restore --clean --if-exists --no-owner --no-acl --dbname "$RESTORE_DATABASE_URL"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS migration_count FROM __drizzle_migrations;'
