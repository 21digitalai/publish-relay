# Database backups: capture and read-only age coverage

This source implements the approved three-daily plus week/month recovery policy.
It does **not** authorize or implement deletion, deployment, scheduling, migration,
off-host transfer, or production restore. Release retention and tenant media
retention have different owners and are unchanged.

## Capture owner and validation

`deploy/backup-database.sh` remains the only capture entrypoint. It requires
`MIGRATION_DATABASE_URL` and `BACKUP_AGE_RECIPIENT` for encrypted backup capture. The recovery private key is not required on
the capture host: an ephemeral second recipient enables round-trip validation. `BACKUP_DIRECTORY` retains its existing default.
Prerequisites: Bash, PostgreSQL client tools compatible with the database, age plus age-keygen,
Node 24, and standard filesystem tools. No provider credentials are used.

The script creates a private mode-0700 staging directory on the backup filesystem,
dumps PostgreSQL custom format, refuses empty output, and traverses **the entire**
archive with `pg_restore --file=/dev/null`; a table-of-contents-only check cannot
detect every truncated data block. It generates a disposable age key in private staging, encrypts to both the
configured recovery recipient and that disposable recipient, decrypts into private staging,
and compares exact plaintext bytes. The ephemeral key is deleted with staging;
no new persistent recovery credential is introduced. Only successful traversal, encryption and
round-trip comparison permit publication. Plaintext is not a published backup.

A same-directory exclusive capture lock prevents overlapping captures. Complete
encrypted bytes and their SHA-256/size validation receipt are published with
no-clobber hard links; a timestamp collision fails without replacing anything.
Both published files are mode 0600. The receipt records the full-archive and
encrypted-round-trip check, not a claim that an isolated database restore passed.

Success and ordinary failure remove **only this invocation's** named staging files
and lock. Failure never runs a planner or pruner. A crash between the two final
links leaves a complete but unreceipted backup: it is retained, never assumed
verified. SIGKILL/power loss can leave private plaintext/ephemeral-key staging and a lock; an
owner must inspect that abandoned capture and remove only its confirmed staging
and lock before retrying. There is no broad automatic orphan cleanup.
Filesystem atomic publication is not a guarantee against storage hardware loss.

This source must not be deployed until the owner verifies the configured recovery recipient using an isolated
restore drill with the real off-host recovery identity. Keep protected/off-host recovery
copies and keys independently from a potentially compromised application host.
Local validation/retention cannot prove off-host protection or detect an already
compromised database snapshot.

## Exact dry-run manifest

After building, inspect a dedicated backup directory with an explicit pin file:

```bash
node dist/entrypoints/backup-retention.js inspect /absolute/backups /absolute/pins.json
```

The command is read-only. There is **no apply command**, delete flag, scheduled
prune, or integration into capture/deploy. `approvedDeletePaths` is always empty;
`candidatePaths` is only an advisory proposal, never a deletion instruction.
The output includes every immediate entry, exact absolute path, byte count,
SHA-256 for recognized regular encrypted backups, verification state and reasons.
Receipt files, legacy `.dump` files, staging directories, locks, symlinks,
unrecognized names, hard-linked files and missing/malformed/mismatching receipts
remain protected. The collector never follows backup/receipt symlinks. A changing
recognized file or unsafe root aborts inspection rather than emitting a partial plan.

Receipts are local integrity attestations tied to exact encrypted bytes, not
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
the exact source, scheduled entrypoint, compatible PostgreSQL/age tooling,
off-host recovery identity access, protected off-host copies and a full isolated restore drill.
Existing data deletion requires a separate exact approved manifest, fresh
revalidation and race-safe serialized apply implementation. None is supplied here.
