# Publish Relay deployment

Production uses immutable releases under `/opt/publish-relay/releases`, an atomic `current` symlink, and separate hardened systemd web and worker units. Secrets belong in the root-owned `/etc/publish-relay/publish-relay.env` file and are injected from the approved vault; they never belong in a release.

Deployment order is build artifact transfer, `publish-release.sh`, forward migration, atomic symlink switch, unit restart, and readiness verification. A failed migration stops before the symlink changes. Application rollback uses `rollback-release.sh`; migrations must remain backward compatible under the expand/migrate/contract rule.

`backup-database.sh` creates an age-encrypted custom-format PostgreSQL backup with a 14-day default retention. `restore-drill.sh` restores only to an explicitly supplied isolated database and proves the migration ledger is readable. Operators must record the backup path, restore database, row-count checks, elapsed time, and cleanup in the deployment ticket without copying secrets.

Reverse proxy TLS termination must forward only to `127.0.0.1:3100`. Verify `/health/live`, `/health/ready`, login, protected-shell redirect behavior, worker restart survival, journald logs, and absence of changes to existing services before cutover.
