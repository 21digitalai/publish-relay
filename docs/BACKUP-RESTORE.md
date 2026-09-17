# Backup and restore

Backups use the trusted deployment-only migration authority, which must have `BYPASSRLS`,
because runtime logins are intentionally constrained and every tenant table forces RLS.
Never expose `MIGRATION_DATABASE_URL` to web or worker units.

## Capture

For a local custom-format backup:

```bash
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" \
BACKUP_DIRECTORY=/var/backups/publish-relay \
deploy/backup-database.sh --local
```

For encrypted capture, omit `--local` and set `BACKUP_AGE_RECIPIENT`. The command validates
the PostgreSQL archive before publishing it. It does not prune old backups; retention and
off-site copies remain an operator policy.

## Restore drill

Create an isolated database whose name ends in `_restore` or `_restore_drill`, then run:

```bash
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" \
RESTORE_DATABASE_URL="$RESTORE_DATABASE_URL" \
deploy/restore-drill.sh /path/to/publish-relay-TIMESTAMP.dump
```

Encrypted archives additionally require `BACKUP_AGE_IDENTITY`. The script rejects the
production URL and production database name, validates the archive, restores with
`--exit-on-error`, and proves the migration ledger is readable.

On a new PostgreSQL cluster, first run `deploy/provision-database-roles.sql` against the isolated
target as a role administrator. Then run `deploy/bootstrap-database-authorities.sql` as the
restored database owner, start the application against that target, verify representative
tenant counts and readiness, then remove only the isolated drill database. Existing clusters
normally already have the fixed roles. Record archive hash, target database, checks, duration,
and cleanup without recording credentials.
