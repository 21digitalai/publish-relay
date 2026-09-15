# Publish Relay deployment

## Persistent macOS development runtime

Run `deploy/macos/publish-relay-local.sh install` after a Node 24 build to create three native per-user launchd services: PostgreSQL on isolated port 55436, web on 127.0.0.1:3106, and the durable worker. The controller initializes and migrates a private database, provisions distinct migration/web/worker authorities, installs host-specific plists in `~/Library/LaunchAgents` so they return automatically after login/reboot, and generates Vault-injected wrappers beneath `${XDG_STATE_HOME:-$HOME/.local/state}/publish-relay`. Secrets and machine paths remain outside source control. `uninstall` removes the persistent LaunchAgent registrations while preserving runtime data.

The commands are `install`, `start`, `stop`, `restart`, `status`, and `uninstall`. launchd restarts crashed processes; logs and media live below the runtime root. Uninstall unloads services but preserves runtime data for recovery. Tool paths and ports can be overridden with `PUBLISH_RELAY_NODE_BIN`, `PUBLISH_RELAY_POSTGRES_BIN`, `PUBLISH_RELAY_POSTGRES_PORT`, and `PUBLISH_RELAY_PORT`.

Production uses immutable releases under `/opt/publish-relay/releases`, an atomic `current` symlink, and separate hardened systemd web and worker units. Web secrets belong in root-owned `/etc/publish-relay/publish-relay-web.env`; worker secrets belong in `/etc/publish-relay/publish-relay-worker.env`. Both are injected from the approved vault and never belong in a release. The deployment-only `MIGRATION_DATABASE_URL` is supplied to release, backup, and restore tooling without placing it in either runtime environment file.

## Database authorities

Provision the fixed `NOLOGIN` group roles with `bootstrap-database-authorities.sql` as a PostgreSQL administrator, then create separate secret-bearing login roles outside source control and grant each login exactly one runtime role. `DATABASE_URL` must authenticate as the web login granted `publish_relay_web`; `WORKER_DATABASE_URL` must authenticate as the worker login granted `publish_relay_worker`. Each entrypoint starts its connections with `SET ROLE` through PostgreSQL startup options, so group authority—not login-role attributes—is the effective runtime authority. The worker group has `BYPASSRLS` for cross-workspace claim/recovery queries. A separate no-login `publish_relay_token_exchange` definer also has `BYPASSRLS` solely so opaque, globally unique delegated code/token hashes can resolve before their workspace is known; the web login can execute those functions but cannot assume that role. Scheduler code must return to `withTenantTransaction` for every workspace-specific mutation. The migration login is separate and must not be used by either runtime unit.

Run the bootstrap again after forward migrations so grants cover newly created tables and sequences. The script is idempotent. Verify with `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'publish_relay_%'`; only `publish_relay_worker` and the no-login `publish_relay_token_exchange` definer may report `true`. Do not put login passwords in the SQL file, release, unit, or deployment ticket.

Deployment uses the serialized [single-release lifecycle](RELEASE-RETENTION.md): exactly one
release normally, two temporarily, then one after verified success or successful recovery.
Provision the deployment-owned root first. The script installs production dependencies,
runs compiled migration/bootstrap, switches atomically, restarts and smokes both services.
A failure restores and verifies the prior application before cleaning the candidate; uncertain
recovery leaves both artifacts and a lock for owner inspection. Existing deployments with
new migration files require a separate reviewed recovery procedure. Later rollback rebuilds
an approved Git commit and calls `rollback-release.sh <new-id> <built-source-directory>`;
it does not require retained old code. No database restore is performed.

The release script enters the immutable release directory before invoking the migration and authority-bootstrap commands through `sudo`. Do not use sudo's `--chdir`/`-D` option: production intentionally applies a hardened sudo policy that rejects it. Keep the explicit Node 24 and PostgreSQL binaries allowlistable. The password-free `MIGRATION_DATABASE_URL` is passed to `psql` as its explicit database argument so hardened sudo environment filtering cannot fall back to a local Unix socket; only `PGPASSWORD` is preserved for that child command.

Install an isolated Node 24 toolchain under `/opt/publish-relay/node24` before the first release. `publish-release.sh` fails closed unless `PUBLISH_RELAY_NODE_BIN` is executable, reports Node 24, and `PUBLISH_RELAY_NPM_CLI` is present; defaults point to the isolated Node binary and its `lib/node_modules/npm/bin/npm-cli.js`. The script invokes that npm CLI through the selected Node binary, so an `env node` launcher cannot fall back to host Node 22. The absolute Node path is pinned directly in both systemd `ExecStart` commands. Preflight with `/opt/publish-relay/node24/bin/node --version`, which must report `v24.x`.

`backup-database.sh --local` creates an atomically published, fully traversed plain custom-format PostgreSQL backup on the same VPS, requiring no age or off-site setup. No-argument invocation preserves optional age encryption with disposable-recipient round-trip validation. Neither mode deletes existing backups. [Backup age-coverage planning](BACKUP-RETENTION.md) documents the read-only three-daily plus 7/30-day policy, bridge copies, explicit pins, exact manifest, and owner installation/activation instructions for the repo-owned daily systemd timer. Backups and migrations require `MIGRATION_DATABASE_URL`, never either runtime URL. `restore-drill.sh` uses that production authority only for target protection and requires an isolated `RESTORE_DATABASE_URL`; it rejects the production database by URL or database name and requires the restore database name to end in `_restore` or `_restore_drill` before running destructive `pg_restore --clean`. After restore, run the authority bootstrap against the isolated target before application verification. It then proves the migration ledger is readable. Operators must record the backup path, restore database, row-count checks, elapsed time, and cleanup in the deployment ticket without copying secrets.

Reverse proxy TLS termination must forward only to the isolated Publish Relay listener, initially `127.0.0.1:3106` (`HOST=127.0.0.1`, `PORT=3106`). `publish-release.sh` probes `PUBLISH_RELAY_HEALTH_URL`, defaulting to `http://127.0.0.1:3106/health/ready`. Keep `/metrics` restricted to host monitoring. Verify `/health/live`, `/health/ready`, login, protected-shell redirect behavior, worker restart survival, process metrics, journald logs, and absence of changes to existing services before cutover.

## Release lifecycle and historical audit

[Single-release deployment and recovery](RELEASE-RETENTION.md) owns current source policy.
Historical assessments remain read-only keep-all manifests; the old current-plus-three
proposal policy is retired. Source approval is not live rollout or historical-delete approval.
