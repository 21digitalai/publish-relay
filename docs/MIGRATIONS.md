# Migration compatibility

Migrations under `migrations/` are immutable, ordered, and forward-only. Never edit an
already released migration. Add a new migration for every schema correction.

Use expand/migrate/contract changes:

1. **Expand:** add nullable or backward-compatible schema.
2. **Migrate:** deploy code that can read old and new states and backfill safely.
3. **Contract:** remove old schema only after every supported release no longer needs it.

Before release, compare the running and target migration trees, test a fresh database, test
an upgrade from the current release, and prove the prior application release can still start
after target migrations. If it cannot, mark the release as non-rollback-compatible and require
a reviewed database recovery plan before activation.

Run migrations with the database owner through `npm run db:migrate` in development or the
compiled `dist/database/migrate.js` in production. Re-run the authority bootstrap afterward
so grants cover new tables, sequences, and audited security-definer functions.
