# Publish Relay deployment

## Update an existing installation

**Use reviewed main; source synchronization is not deployment.** The shipped
activation script supports standalone Core on Linux/systemd with separate
`publish-relay-web` and `publish-relay-worker` units and the immutable layout
below. Hosted uses its private repository's guarded composition deployment.
Cloudflare, containers, non-systemd supervisors and other layouts are unsupported
by this command: stop before activation and obtain a reviewed topology-specific
procedure. Do not infer success from a pull.

### Build the exact reviewed source

In a source checkout with the correct upstream, fetch main and build in a NEW
clean directory outside the running application:

```sh
git fetch origin main
git worktree add --detach /path/to/clean-candidate origin/main
cd /path/to/clean-candidate
git rev-parse HEAD
node --version
npm ci
npm run check
```

Record the full SHA. Use Node **24** and npm 11; the deploy script requires
Node 24 even if development accepts newer versions. Do not reuse ignored dist.
Transfer the checked source plus freshly built dist as one immutable candidate.
Review migration files and journal against the installed release for forward
compatibility. New API/CLI authority functions need their migrations, not just
new JavaScript. Never substitute one-off SQL for the migration runner.

**Current standalone guard limitation:** an existing installation's candidate and
selected release must have byte-identical migration trees, including metadata.
An update adding migrations therefore STOPS at preflight, even when append-only.
Do not bypass the guard, remove the old release, or apply SQL manually to force it.
Such an update needs a separately reviewed migration-compatible activation and
recovery procedure. First install and same-migration updates still run the
canonical forward migration runner. Hosted's separate append-only guard does
not authorize weakening the standalone guard.

### Preflight and backup on the installation host

Confirm the release root/current symlink, service user, both units, listener,
readiness URL and selected Node/npm/psql paths against this installation.
Set the documented PUBLISH_RELAY_* path overrides where defaults differ.
Web and worker need separate database authorities and matching adapter/provider
configuration in their protected env files, not in a release. Provision the
group roles once using the Database authorities section below.

Fail closed before activation unless these checks pass:

```sh
test "$(uname -s)" = Linux
command -v systemctl
command -v sudo
command -v lsof
command -v curl
systemctl cat publish-relay-web publish-relay-worker
/opt/publish-relay/node24/bin/node --version
```

Require v24 from the configured Node path (substitute it if overridden).
Load MIGRATION_DATABASE_URL securely in the deployment-owner environment, not
either runtime URL. Verify PostgreSQL client tools. From the built candidate:

```sh
backup_path="$(bash deploy/backup-database.sh --local)"
bash deploy/restore-drill.sh "$backup_path"
```

Set RESTORE_DATABASE_URL to an isolated disposable database ending in _restore
or _restore_drill; the drill rejects the production database name. Bootstrap
authorities on the isolated target and verify representative row counts and
migration ledger per [backup/restore](../docs/BACKUP-RESTORE.md). Record backup
path, restore target, elapsed time and proof without secrets. Stop on any
failure. Keep the backup; remove the isolated target only after verification.

### Activate and verify

As deployment owner with the required privileges on the installation host:

```sh
bash deploy/publish-release.sh <unique-release-id> /absolute/path/to/checked-candidate
```

Replace both placeholders. This existing lifecycle is the only activation engine:
it validates artifact and migration compatibility, serializes deployment, installs
production dependencies, runs compiled forward migrations and authority bootstrap,
switches current atomically, restarts BOTH web and worker, and probes readiness.
It does not create the backup for you; the previous step is mandatory.

Inspect current and compare installed source/build with the recorded reviewed SHA.
Verify both processes run from that release, configured /health/live and
/health/ready, login/protected routes, worker logs and the newly required API
plus shipped CLI/discovery contract. Health alone is not version/API proof.
Record SHA, release ID and migration ledger; never claim another installation
was upgraded without runtime evidence from it.

On failure, do not blindly retry or delete the lock. Failed activation restores
and verifies the previous application; uncertain recovery preserves both releases
and the lock for owner inspection. Migrations are forward-only: application
recovery never reverses schema. Follow [retention/recovery](RELEASE-RETENTION.md)
and [upgrade/rollback](../docs/UPGRADE.md); incompatible migrations need a
reviewed recovery plan, not reverse SQL or switching branches.

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

## DuckDNS Caddy candidate

The isolated `caddy/publish-relay.Caddyfile` uses the approved
`publish-relay.duckdns.org` hostname, Caddy's normal public ACME flow, and
persistent file storage under `/data/caddy`. The host owner must provision
that data directory with the Caddy service's ownership and persistence (the existing
Droplet container mounts its named Caddy data volume at `/data`; do not move global
storage to an unmounted container path or discard existing Mobile API certificate
state), then run
`caddy adapt --config deploy/caddy/publish-relay.Caddyfile --adapter caddyfile` and
`caddy validate --config deploy/caddy/publish-relay.Caddyfile --adapter caddyfile`.
Do not include this fragment until the operator has verified DNS resolution and
public certificate issuance for the exact hostname; source validation is not
certificate issuance or renewal proof. Merge its global options at the top of the operator-owned Caddyfile;
do not import the whole file after an existing site block. Caddy renews the
certificate from its persistent storage; if adaptation, validation,
issuance, or readiness fails, leave the existing Mobile API configuration active,
remove only the uncommitted Relay candidate, and reload the last known-good config.
Keep the existing Mobile API site block unchanged. Main may apply the reviewed
candidate with `caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`
only after the rollout gate, then verify `curl --fail https://publish-relay.duckdns.org/health/ready`
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
