# Publish Relay deployment

Production uses immutable releases under `/opt/publish-relay/releases`, an atomic `current` symlink, and separate hardened systemd web and worker units. Web secrets belong in root-owned `/etc/publish-relay/publish-relay-web.env`; worker secrets belong in `/etc/publish-relay/publish-relay-worker.env`. Both are injected from the approved vault and never belong in a release. The deployment-only `MIGRATION_DATABASE_URL` is supplied to release, backup, and restore tooling without placing it in either runtime environment file.

## Database authorities

Create the secret-bearing migration, web, and worker logins outside source control. As a PostgreSQL role administrator, run `provision-database-roles.sql` once per cluster to create the fixed `NOLOGIN` group roles and grant each runtime login exactly one group role. The migration login owns the database and has `BYPASSRLS`, but never `CREATEROLE` or `CREATEDB`; its ongoing duties are migrations, backups, restores, and database-object grants only. `DATABASE_URL` must authenticate as the web login granted `publish_relay_web`; `WORKER_DATABASE_URL` must authenticate as the worker login granted `publish_relay_worker`. Each entrypoint starts its connections with `SET ROLE` through PostgreSQL startup options, so group authority—not login-role attributes—is the effective runtime authority. The worker group alone has `BYPASSRLS` for cross-workspace claim/recovery queries. Scheduler code must return to `withTenantTransaction` for every workspace-specific mutation. The migration login is separate and must not be used by either runtime unit.

Run `bootstrap-database-authorities.sql` as the database owner after forward migrations so grants cover newly created tables, sequences, and functions. The script is idempotent and fails closed when the administrator-owned roles are missing. Verify with `SELECT rolname, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname LIKE 'publish_relay_%'`; only the worker group and migration login may report `rolbypassrls=true`, and no application login may report role/database creation authority. Do not put login passwords in the SQL file, release, unit, or deployment ticket.

Deployment uses the serialized [single-release lifecycle](RELEASE-RETENTION.md): exactly one release normally, two temporarily, then one after verified success or successful recovery. Provision the deployment-owned root first. `publish-release.sh` copies the reviewed source and `dist` artifact, installs production dependencies, restores the reviewed `dist` tree after npm, normalizes service-readable permissions, runs compiled migration/bootstrap, switches atomically, restarts both units, and probes readiness. A failure restores and verifies the previous application before cleaning the candidate; uncertain recovery preserves both releases and the deployment lock for owner inspection.

Later rollback rebuilds a compatible approved Git commit and calls `rollback-release.sh <new-release-id> <built-source-directory>`. It uses the same guarded lifecycle and does not depend on a retained old tree or reverse database migrations. Existing deployments with new migration files require a separately reviewed recovery procedure. The release source must contain `dist/database/migrate.js` and `deploy/bootstrap-database-authorities.sql`; production never builds or depends on the development-only `tsx` runtime.

The release script enters the immutable release directory before invoking the migration and authority-bootstrap commands through `sudo`. Do not use sudo's `--chdir`/`-D` option: production intentionally applies a hardened sudo policy that rejects it. Keep the explicit Node 24 and PostgreSQL binaries allowlistable. The password-free `MIGRATION_DATABASE_URL` is passed to `psql` as its explicit database argument so hardened sudo environment filtering cannot fall back to a local Unix socket; only `PGPASSWORD` is preserved for that child command.

Install an isolated Node 24 toolchain under `/opt/publish-relay/node24` before the first release. `publish-release.sh` fails closed unless `PUBLISH_RELAY_NODE_BIN` is executable, reports Node 24, and `PUBLISH_RELAY_NPM_CLI` is present; defaults point to the isolated Node binary and its `lib/node_modules/npm/bin/npm-cli.js`. The script invokes that npm CLI through the selected Node binary, so an `env node` launcher cannot fall back to host Node 22. The absolute Node path is pinned directly in both systemd `ExecStart` commands. Preflight with `/opt/publish-relay/node24/bin/node --version`, which must report `v24.x`.

`backup-database.sh --local` creates a validated plain custom-format PostgreSQL backup; no-argument capture encrypts with age. Capture never deletes existing archives. Backups and migrations require `MIGRATION_DATABASE_URL`, never either runtime URL. `restore-drill.sh` accepts either format, uses production authority only for target protection, and requires an isolated `RESTORE_DATABASE_URL`; it rejects the production database by URL or database name and requires the restore database name to end in `_restore` or `_restore_drill` before running destructive `pg_restore --clean`. After restore, run the authority bootstrap against the isolated target before application verification. It then proves the migration ledger is readable. Operators must record the backup path, restore database, row-count checks, elapsed time, and cleanup without copying secrets. See `docs/BACKUP-RESTORE.md`.

Reverse proxy TLS termination must forward only to the isolated Publish Relay listener, initially `127.0.0.1:3106` (`HOST=127.0.0.1`, `PORT=3106`). `publish-release.sh` probes `PUBLISH_RELAY_HEALTH_URL`, defaulting to `http://127.0.0.1:3106/health/ready`. Keep `/metrics` restricted to host monitoring. Verify `/health/live`, `/health/ready`, login, protected-shell redirect behavior, worker restart survival, process metrics, journald logs, and absence of changes to existing services before cutover.

## Direct-IP Caddy candidate

The isolated `caddy/publish-relay.Caddyfile` uses Caddy's public ACME issuer with
the `shortlived` profile, persistent file storage under `/data/caddy`, and
`default_sni` set to the configured origin IP for clients that omit SNI. Caddy
2.11.4 or newer is required for the tested syntax. The host owner must provision
that data directory with the Caddy service's ownership and persistence (the existing
Droplet container mounts its named Caddy data volume at `/data`; do not move global
storage to an unmounted container path or discard existing Mobile API certificate
state), then run
`caddy adapt --config deploy/caddy/publish-relay.Caddyfile --adapter caddyfile` and
`caddy validate --config deploy/caddy/publish-relay.Caddyfile --adapter caddyfile`
with `PUBLISH_RELAY_ORIGIN_HOST` set. Do not include this fragment until the
operator has verified that the chosen ACME CA will issue a publicly trusted
certificate for the exact IP; source validation is not certificate issuance or
renewal proof. Merge its global options at the top of the operator-owned Caddyfile;
do not import the whole file after an existing site block. Caddy renews the
short-lived certificate from its persistent storage; if adaptation, validation,
issuance, or readiness fails, leave the existing Mobile API configuration active,
remove only the uncommitted Relay candidate, and reload the last known-good config.
Keep the existing Mobile API site block unchanged. Main may apply the reviewed
candidate with `caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`
only after the rollout gate, then verify `curl --fail https://$PUBLISH_RELAY_ORIGIN_HOST/health/ready`
and the certificate chain before proceeding to Worker cutover.

## Droplet Compose candidate

`compose/docker-compose.yml` is the reviewed-preparation candidate for the existing
Droplet when Relay owns a private PostgreSQL 16 container instead of the Mobile API's
managed database. It publishes PostgreSQL only on the Compose network, binds Relay web
to loopback for Caddy, applies explicit CPU/memory limits, and keeps web, worker, and
migration env files separate. Follow `compose/README.md`; do not deploy it, restore a
database, reload Caddy, or publish the Worker until the candidate is independently
reviewed and the operator's cutover gate is reconciled.

`caddy/publish-relay.Caddyfile` is an isolated include candidate. It must not replace
the existing Mobile API route. `edge/` contains the source-owned Worker candidate: it
allows only the explicitly configured HTTPS direct origin, preserves cookies and CSRF
headers, replaces untrusted forwarding headers, rewrites same-origin redirects, and
forces `Cache-Control: no-store`. It deliberately has no tunnel fallback.

Historical cleanup is never inferred from age or release count. `release-filesystem.mjs` validates canonical roots, links, migrations, active process working directories, and open-file use before bounded removal. Migration differences, legacy extra releases, or stale/unknown observations fail closed. See [RELEASE-RETENTION.md](RELEASE-RETENTION.md) for activation and recovery boundaries.
