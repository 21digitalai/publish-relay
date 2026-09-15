#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <backup.dump|backup.dump.age>" >&2
  exit 64
fi
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required for production-target protection}"

restore_database_name="$(node -e 'process.stdout.write(new URL(process.argv[1]).pathname.slice(1))' "$RESTORE_DATABASE_URL")"
production_database_name="$(node -e 'process.stdout.write(new URL(process.argv[1]).pathname.slice(1))' "$MIGRATION_DATABASE_URL")"
if [[ "$RESTORE_DATABASE_URL" == "$MIGRATION_DATABASE_URL" || "$restore_database_name" == "$production_database_name" ]]; then
  echo "restore target must not be the production database" >&2
  exit 65
fi
if [[ ! "$restore_database_name" =~ (_restore|_restore_drill)$ ]]; then
  echo "restore target database name must end in _restore or _restore_drill" >&2
  exit 65
fi

case "$1" in
  *.dump.age)
    : "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY is required for encrypted backups}"
    age -d -i "$BACKUP_AGE_IDENTITY" "$1" | pg_restore --exit-on-error --clean --if-exists --no-owner --no-acl --dbname "$RESTORE_DATABASE_URL"
    ;;
  *.dump)
    [[ -s "$1" && ! -L "$1" ]] || { echo "regular nonempty backup required" >&2; exit 65; }
    pg_restore --no-owner --no-acl --file=/dev/null "$1"
    pg_restore --exit-on-error --clean --if-exists --no-owner --no-acl --dbname "$RESTORE_DATABASE_URL" "$1"
    ;;
  *) echo "expected .dump or .dump.age backup" >&2; exit 64 ;;
esac
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS migration_count FROM __drizzle_migrations;'
