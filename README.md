# Publish Relay

Standalone multi-tenant social scheduling product implemented as a TypeScript modular monolith.

## Requirements

- Node.js 24+
- npm 11+
- PostgreSQL 16+
- `pg_dump`, `pg_restore`, and `psql` for backup and recovery

## Commands

- `npm ci` — reproducible install
- `npm run dev:web` — Fastify API process with watch mode
- `npm run dev:worker` — durable worker process with watch mode
- `npm run dev:ui` — Vite development server
- `npm run check` — formatting, lint, strict typecheck, unit tests, and production builds
- `npm run test:e2e` — Playwright browser smoke test

Start with the [self-host installation guide](docs/INSTALL.md). Copy `.env.example` to
`.env`, generate fresh local secrets, and keep provider credentials empty until a provider
is intentionally enabled. The same build provides separate `web` and `worker` entrypoints;
domain modules live under `src/modules` and expose public contracts instead of sharing
persistence internals.

Lightweight, API-first, multi-tenant social scheduling and publishing.

## Operations and project policy

- [Install and first smoke](docs/INSTALL.md)
- [Upgrade and rollback](docs/UPGRADE.md)
- [Backup and restore](docs/BACKUP-RESTORE.md)
- [Release checklist](docs/RELEASE.md)
- [Migration compatibility](docs/MIGRATIONS.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

Publish Relay Core is provider-neutral. X is the first production-proven adapter. YouTube,
Instagram, and Facebook parity are not claimed by this release candidate.

## License

Publish Relay Core is licensed under the GNU Affero General Public License v3.0
(`AGPL-3.0-only`). See `LICENSE`.
Third-party dependency names, versions, licenses, and source repositories are listed in
`THIRD_PARTY_NOTICES.csv`; the redistributed Python-2.0 and CC-BY-4.0 license texts are
preserved under `LICENSES/`.

`SBOM.cdx.json` is the CycloneDX software bill of materials generated from the exact
committed npm lockfile for this Core candidate.
