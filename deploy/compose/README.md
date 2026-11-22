# Compose deployment candidate

This candidate runs Relay web and worker containers with a private PostgreSQL 16
container. PostgreSQL has no published port; only the web listener is bound to
loopback for the existing Caddy reverse proxy. The named database and media volumes
must be backed up before any migration or cutover.

Create root-owned, mode `0600` env files outside the release:

- `postgres.env`: `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` for the
  database owner used to bootstrap the isolated database.
- `migration.env`: `DATABASE_URL` for the migration login and the application master
  and signing keys needed by migration tooling.
- `web.env`: `DATABASE_URL` for `publish_relay_web_login`, `PUBLISH_RELAY_PUBLIC_ORIGIN`,
  and web/provider settings. Use `postgres` as the database hostname.
- `worker.env`: `WORKER_DATABASE_URL` for `publish_relay_worker_login`, the same
  encryption/signing keys and adapter allowlist as web, plus worker settings.

Provision the three login authorities and fixed group roles with the SQL files in the
parent `deploy/` directory before running the migration profile. Never put the
migration URL in web or worker env files.

```bash
docker compose -f deploy/compose/docker-compose.yml build
docker compose -f deploy/compose/docker-compose.yml --profile migration run --rm migration
docker compose -f deploy/compose/docker-compose.yml up -d postgres web worker
```

Run the backup and restore-drill helpers against the migration URL before cutover.
The Compose file is an implementation candidate only; it does not authorize remote
deployment, database restore, Caddy reload, Worker publish, or provider callbacks.
