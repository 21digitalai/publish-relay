# Publish Relay deployment

Production uses immutable releases under `/opt/publish-relay/releases`, an atomic `current` symlink, and separate hardened systemd web and worker units. Secrets belong in the root-owned `/etc/publish-relay/publish-relay.env` file and are injected from the approved vault; they never belong in a release.

Deployment order is build artifact transfer, `publish-release.sh`, production-dependency install, compiled forward migration, atomic symlink switch, unit restart, and readiness verification. A failed migration stops before the symlink changes. The release must contain `dist/database/migrate.js`; production deployment never depends on the development-only `tsx` runtime. Application rollback uses `rollback-release.sh`; migrations must remain backward compatible under the expand/migrate/contract rule.

`backup-database.sh` creates an age-encrypted custom-format PostgreSQL backup with a 14-day default retention. `restore-drill.sh` requires both the production `DATABASE_URL` and an isolated `RESTORE_DATABASE_URL`, rejects the production database by URL or database name, and requires the restore database name to end in `_restore` or `_restore_drill` before running destructive `pg_restore --clean`. It then proves the migration ledger is readable. Operators must record the backup path, restore database, row-count checks, elapsed time, and cleanup in the deployment ticket without copying secrets.

Reverse proxy TLS termination must forward only to `127.0.0.1:3100`. Keep `/metrics` restricted to host monitoring. Verify `/health/live`, `/health/ready`, login, protected-shell redirect behavior, worker restart survival, process metrics, journald logs, and absence of changes to existing services before cutover.
