#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <encrypted-backup>" >&2
  exit 64
fi
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
: "${DATABASE_URL:?DATABASE_URL is required for production-target protection}"
: "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY is required}"

restore_database_name="$(node -e 'process.stdout.write(new URL(process.argv[1]).pathname.slice(1))' "$RESTORE_DATABASE_URL")"
production_database_name="$(node -e 'process.stdout.write(new URL(process.argv[1]).pathname.slice(1))' "$DATABASE_URL")"
if [[ "$RESTORE_DATABASE_URL" == "$DATABASE_URL" || "$restore_database_name" == "$production_database_name" ]]; then
  echo "restore target must not be the production database" >&2
  exit 65
fi
if [[ ! "$restore_database_name" =~ (_restore|_restore_drill)$ ]]; then
  echo "restore target database name must end in _restore or _restore_drill" >&2
  exit 65
fi

age -d -i "$BACKUP_AGE_IDENTITY" "$1" | pg_restore --clean --if-exists --no-owner --no-acl --dbname "$RESTORE_DATABASE_URL"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS migration_count FROM __drizzle_migrations;'
