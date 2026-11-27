# Upgrade and rollback

Publish Relay uses immutable application releases and forward-only database migrations.

1. Configure the backup destination and isolated restore target for the guarded backup/restore drill.
2. Fetch reviewed main (or an exact reviewed main commit) into a new directory.
3. Run `npm ci`, `npm run check`, and review `migrations/` against the running release.
4. Build once with Node 24. Transfer the reviewed source plus `dist` artifact.
5. Run `deploy/update-release.sh <release-id> <built-source-directory>` from the deployment owner account.
6. Verify both services, `/health/ready`, login, a protected route, worker logs, and metrics.

`update-release.sh` requires MIGRATION_DATABASE_URL and an isolated RESTORE_DATABASE_URL, runs the shipped backup/restore and isolated authority bootstrap, then delegates to the existing publish-release.sh transaction. See the [canonical update procedure](../deploy/README.md#update-an-existing-installation).

`publish-release.sh` installs production dependencies and then restores the reviewed `dist`
artifact, because npm may remove build output. It normalizes the candidate so the service
account can read it, migrates before switching `current`, and serializes the complete release
lifecycle. A failed migration stops activation. A failed readiness probe restores and verifies
the previous release before candidate cleanup; uncertain recovery preserves both releases and
the lock for inspection. See [`deploy/RELEASE-RETENTION.md`](../deploy/RELEASE-RETENTION.md).

Application rollback does **not** reverse schema. Rebuild a previously reviewed compatible
commit with Node 24, then run
`deploy/rollback-release.sh <new-release-id> <rebuilt-source-directory>`. The wrapper uses the
same guarded activation and recovery lifecycle; it does not require a retained old release.
If migration compatibility is uncertain, stop and use a reviewed recovery procedure.

A historical source tree missing newly installed migration history is a schema
downgrade and is refused, even if its JavaScript could run against the new schema.
For post-success application rollback, the release owner must review a recovery
artifact containing compatible prior application bytes AND the unchanged current
migration history. Never edit the database ledger, reverse SQL, or bypass the
comparator. Automatic failure recovery within the activation transaction instead
reselects the still-retained prior app and proves readiness on the forward schema;
it never runs that app's old migration tree. The append-only comparator proves
file/journal structure only, not semantic backwards compatibility of SQL.

## Disposable update verification

After building with Node 24, the opt-in
tests/standalone-update.postgres.test.ts suite uses POSTGRES_UPDATE_TEST_URL
(an admin connection to a **disposable local PostgreSQL cluster**),
POSTGRES_UPDATE_BIN (its client binary directory), and
POSTGRES_UPDATE_NPM_CLI (the npm CLI JavaScript entrypoint) with
npm test -- tests/standalone-update.postgres.test.ts. It creates uniquely named
test/restore databases, provisions test runtime roles, runs the real compiled
migration entrypoint and production-only dependency install in the candidate,
and deletes its databases afterward. Never point it at a shared/production
cluster. Backup, restore, migration, authority grants and prior-app readiness/API
checks are real; Linux/systemd/process observations use the existing deployment
fixture on non-Linux hosts. Release-owner checks on the actual supported Linux
installation remain necessary before claiming deployment.

## Divergent reviewer/media migration histories

Migration `0134_catch_up_reviewer_and_media_admission` converges installations
that applied the Unified Instagram migrations before incorporating
`0131_reviewer_access_expiry` and `0132_content_media_amendment_admission`.
Drizzle orders upgrades by timestamp, so older absent entries are not replayed.
The catch-up adds the missing nullable reviewer column/constraint and restores
the canonical media-admission function through a new forward migration.
It is also safe after both historical migrations have already run. Incompatible
reviewer columns or constraints fail closed. Historical SQL, journal entries and
applied ledger rows must not be rewritten; a repaired divergent installation
can legitimately retain fewer historical ledger rows than a fresh installation.
Verify the catch-up hash and resulting schema/authorities, not row count alone.
Back up and rehearse the exact upgrade on an isolated restore before activation.
