# Database backups: capture and read-only age coverage

This source implements the approved three-daily plus week/month recovery policy.
It does **not** authorize or implement deletion, deployment, migration,
off-host transfer, or production restore. Release retention and tenant media
retention have different owners and are unchanged.

## Capture owner and validation

`deploy/backup-database.sh --local` captures a plain custom-format database file
in the same VPS backup directory. It needs `MIGRATION_DATABASE_URL`, Bash,
compatible PostgreSQL clients, Node 24 and standard filesystem tools; no age,
recipient, off-site destination or provider credentials are needed.
`BACKUP_DIRECTORY` retains its existing default, `/var/backups/publish-relay`.

For compatibility, invoking without arguments retains the optional encrypted
capture mode requiring `BACKUP_AGE_RECIPIENT`, age and age-keygen. The recovery
private key is not needed on the capture host.

The script creates a private mode-0700 staging directory on the backup filesystem,
dumps PostgreSQL custom format, refuses empty output, and traverses **the entire**
archive with `pg_restore --file=/dev/null`; a table-of-contents-only check cannot
detect every truncated data block. In optional encrypted mode it generates a disposable age key in private staging, encrypts to both the
configured recovery recipient and that disposable recipient, decrypts into private staging,
and compares exact plaintext bytes. The ephemeral key is deleted with staging;
no new persistent recovery credential is introduced. Only successful traversal, encryption and
round-trip comparison permit encrypted publication. Local mode publishes the fully
traversed plain custom-format archive directly as a `.dump` file.

A same-directory exclusive capture lock prevents overlapping captures. Complete
archive bytes and their SHA-256/size validation receipt are published with
no-clobber hard links; a timestamp collision fails without replacing anything.
Both published files are mode 0600. The receipt records the full-archive check (plus encrypted round-trip in encrypted mode), not a claim that an isolated database restore passed.

Success and ordinary failure remove **only this invocation's** named staging files
and lock. Failure never runs a planner or pruner. A crash between the two final
links leaves a complete but unreceipted backup: it is retained, never assumed
verified. SIGKILL/power loss can leave private plaintext/ephemeral-key staging and a lock; an
owner must inspect that abandoned capture and remove only its confirmed staging
and lock before retrying. There is no broad automatic orphan cleanup.
Filesystem atomic publication is not a guarantee against storage hardware loss.

Local copies provide database rollback coverage, not VPS-loss protection.
Off-site transfer, recovery-custody setup and external alert infrastructure are
not prerequisites for this local mode. Optional encryption does not change that
scope. Neither traversal nor a receipt proves the database was uncompromised.

## Owner installation and daily activation

Source review is separate from activation. After deploying the reviewed source,
the host owner supplies a root-owned mode-0600
`/etc/publish-relay/publish-relay-backup.env` through the existing secret authority,
with the deployment-only `MIGRATION_DATABASE_URL` (not the web/worker URL).
Do not put this secret into command arguments, a release or either runtime env.
The unit runs as root to read that private deployment credential and owns only
the backup directory; it does not grant migration credentials to the app.

Run from the reviewed deployed release, as the authorized host owner:

```bash
install -d -o root -g root -m 0700 /var/backups/publish-relay
install -m 0644 deploy/systemd/publish-relay-backup.service /etc/systemd/system/
install -m 0644 deploy/systemd/publish-relay-backup.timer /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/publish-relay-backup.service /etc/systemd/system/publish-relay-backup.timer
systemctl daemon-reload
systemctl start publish-relay-backup.service
systemctl show publish-relay-backup.service -p Result -p ExecMainStatus
journalctl -u publish-relay-backup.service -n 20 --no-pager
systemctl enable --now publish-relay-backup.timer
systemctl list-timers publish-relay-backup.timer --all
```

The timer captures daily at 02:00 UTC; `Persistent=true` runs one catch-up after
downtime, not fictional backups for missed days. A 30-minute timeout bounds
capture; failed runs preserve existing files. The unit uses the existing
`/opt/publish-relay/current` source and Node 24 installation. No service restart
loop, automatic prune, external alert or new application process is introduced.
If the deployment uses different paths, use systemd overrides and keep the
private writable backup path aligned with `BACKUP_DIRECTORY`.

The owner verifies the printed archive via the existing guarded
`deploy/restore-drill.sh /absolute/backup.dump`: inject
`MIGRATION_DATABASE_URL` for production-target protection and
`RESTORE_DATABASE_URL` for a separately created disposable database named
`*_restore` or `*_restore_drill`. Local restore requires no age identity.
The script traverses the archive before modifying that isolated target, restores
with exit-on-error and reads the migration ledger. Verify representative row
counts, then remove only that disposable database through the owner workflow.
Record the capture path, permissions, counts, elapsed time and cleanup, never
credentials. A manual success does not prove a natural daily run: record the
next timer-triggered success separately. Disable future capture with
`systemctl disable --now publish-relay-backup.timer`; preserve all archives.
No commands in this section authorize deleting legacy or invalid dumps.

## Exact dry-run manifest

After building, inspect a dedicated backup directory with an explicit pin file:

```bash
node dist/entrypoints/backup-retention.js inspect /absolute/backups /absolute/pins.json
```

The command is read-only. There is **no apply command**, delete flag, scheduled
prune, or integration into capture/deploy. `approvedDeletePaths` is always empty;
`candidatePaths` is only an advisory proposal, never a deletion instruction.
The output includes every immediate entry, exact absolute path, byte count,
SHA-256 for recognized regular backups, verification state and reasons.
Receipt files, legacy/unreceipted `.dump` files, staging directories, locks, symlinks,
unrecognized names, hard-linked files and missing/malformed/mismatching receipts
remain protected. The collector never follows backup/receipt symlinks. A changing
recognized file or unsafe root aborts inspection rather than emitting a partial plan.

Receipts are local integrity attestations tied to exact archive bytes, not
independently authenticated restore certificates. Existing backups without this
new receipt are never grandfathered into successful coverage. Their validation
requires a separately approved restore/inventory process; do not manufacture
receipts from filenames or file sizes.

Pin file example (use exact names from the manifest; an empty list must be explicit):

```json
[
  {
    "file": "publish-relay-20260801T020000Z.dump.age",
    "reason": "Pre-migration recovery point; owner has not cleared it"
  }
]
```

Pins are additive and do not expire automatically. Malformed pins refuse the
command; any missing pin forces keep-all. Pinned copies do not certify healthy
coverage on their own. All other unknown/unvalidated files remain protected.

## UTC buckets and bridge lifecycle

- The daily points are the latest successful capture on each of the current UTC
  date and previous two UTC dates (daily ages 0, 1, 2). Failed or future captures
  never replace successful points. Filename capture time is UTC; filesystem mtime
  and the observer's local timezone are not age authority.
- Weekly: the newest verified point aged at least 7 and less than 14 UTC dates.
- Monthly: the newest verified point aged at least 30 and less than 60 UTC dates.
  These upper bounds prevent an arbitrarily ancient copy being reported as
  healthy week/month coverage. Missing dates are not silently synthesized.
- Preserve the oldest younger daily representative aged 3–6 as a bridge to the
  weekly bucket, and the oldest younger representative aged 3–29 as a bridge to
  the monthly bucket. A bridge is retained until it matures; it can then become
  the replacement aged point. One file can satisfy several retention reasons.
- If any daily/weekly/monthly point or named pin is missing, retain **all** entries.
  Thus a cold start accumulates history until aged coverage genuinely exists;
  sparse or stalled backup histories cannot trigger pruning.
- With continuous daily success, complete coverage converges to five requested
  recovery points **plus up to two necessary bridge copies**, before explicit
  pins and unverified artifacts. This is intentionally not a hard five-file cap.
  Keeping only today's five selected points repeatedly would delete the copies
  needed to replace tomorrow's weekly/monthly backups. Duplicate successes not
  needed for a selected point/bridge/pin may appear as candidates only.
- Weekly/monthly ages vary within the stated windows during bridge rotation;
  they are not guaranteed to be exactly 7/30 days old. A year-long simulation
  proves coverage survives successive candidate removal, using only fixtures.
  No live removal is performed by tests or source.

## Verification and remaining owner gates

`npm test -- tests/backup-retention.test.ts tests/backup-capture.test.ts tests/backup-postgres.test.ts` exercises
cold start, sparse history, boundaries, timezone equivalence, duplicate successes,
pins, rotating bridges, exact inventory, integrity mismatch, no-apply CLI and
capture/validation/encryption failure cleanup. Where PostgreSQL client/server tools
are available, the private Unix-socket fixture captures and restores 100 actual
rows, and proves a truncated data archive can pass TOC inspection but fail full
traversal. It opens no network listener and uses no live database. The capture failure fixtures
inject tools deliberately; they are not evidence of a live provider or backup.

Before any live use, independent review and owner approval must reconcile
the exact source, scheduled entrypoint, compatible PostgreSQL tooling and a full
isolated restore drill. Real age/recovery-identity verification applies only if
the optional encrypted mode is selected; it is not a local-backup acceptance gate.
Existing data deletion requires a separate exact approved manifest, fresh
revalidation and race-safe serialized apply implementation. None is supplied here.
