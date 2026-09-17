# Install Publish Relay Core

This guide installs a source checkout with PostgreSQL and no live provider credentials. It
is suitable for evaluating the UI, API, migrations, and deterministic fake-provider test
path. Connecting or publishing to a real provider is a separate, explicit action.

## 1. Install prerequisites

- Node.js 24 and npm 11
- PostgreSQL 16 or newer, including `psql`, `pg_dump`, and `pg_restore`
- OpenSSL for generating local secrets

Clone the repository, then run:

```bash
npm ci
cp .env.example .env
```

Generate a cursor secret with `openssl rand -hex 32` and a master key with
`openssl rand -base64 32`. Put those values in `.env`; do not commit `.env`.

## 2. Create database authorities

As a PostgreSQL administrator, create one database owner and two runtime logins. None of
these logins receives ongoing cluster-role administration. Replace the example passwords
before use:

```sql
CREATE ROLE publish_relay_migrator_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD 'replace-migrator-password';
CREATE ROLE publish_relay_web_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'replace-web-password';
CREATE ROLE publish_relay_worker_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'replace-worker-password';
CREATE DATABASE publish_relay OWNER publish_relay_migrator_login;
```

Still as a PostgreSQL role administrator, connect to the new database and provision the
fixed no-login authorities plus runtime memberships. `ADMIN_DATABASE_URL` must name the
new `publish_relay` database:

```bash
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f deploy/provision-database-roles.sql
```

Role administration ends here. Run migrations and database-object grants with the database
owner URL:

```bash
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:migrate
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f deploy/bootstrap-database-authorities.sql
```

`BYPASSRLS` is required for the trusted deployment-only migration authority because migrations
and full-database backups must traverse every forced-RLS tenant table. It does not need
`CREATEROLE` or `CREATEDB`. Never expose its URL to either runtime service. If your
administrator, database owner, and login-role creator are different accounts, the role
administrator owns only the provisioning step; the database owner owns migrations and the
database-authority bootstrap. Never use the migrator URL for the web or worker process.

## 3. Start without providers

Export `.env` with your shell's environment loader, then start the two processes in separate
terminals:

```bash
npm run build
npm run start:web
npm run start:worker
```

Unset X and Google credential pairs keep those adapters disabled. Do not export optional
provider variables as empty strings; leave the commented sample lines unset. The worker logs a bounded
`provider_disabled` event and continues non-provider maintenance. Verify:

```bash
curl --fail http://127.0.0.1:3106/health/live
curl --fail http://127.0.0.1:3106/health/ready
```

Run `npm run test:e2e` for the credential-free fake-provider browser path. The fake adapter
is a test fixture and is never registered as a production publishing destination.

## 4. Production baseline

Build and test the exact commit before deploying: `npm run check`. Use the hardened systemd
units and immutable-release scripts under `deploy/`; see [deploy/README.md](../deploy/README.md).
Terminate TLS at a reverse proxy, keep `/metrics` private, use separate database logins, and
store environment files outside the release with mode `0600`.
