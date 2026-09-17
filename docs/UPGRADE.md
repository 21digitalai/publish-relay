# Upgrade and rollback

Publish Relay uses immutable application releases and forward-only database migrations.

1. Back up the database and complete a restore drill.
2. Fetch the target tag or exact commit into a new directory.
3. Run `npm ci`, `npm run check`, and review `migrations/` against the running release.
4. Build once with Node 24. Transfer the reviewed source plus `dist` artifact.
5. Run `deploy/publish-release.sh <release-id> <built-source-directory>` from the deployment owner account.
6. Verify both services, `/health/ready`, login, a protected route, worker logs, and metrics.

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
