# Single-release deployment and recovery

The normal state is **one deployed release**. A deployment temporarily creates a second
candidate, switches `current`, restarts both units and performs bounded readiness smoke.
Success removes the old code; failure switches back, restarts and verifies the old code,
then removes the failed candidate. Later application rollback means rebuilding the approved
Git commit into a fresh artifact and deploying it through the same transaction—not retaining
three code copies on the VPS. Database backup age coverage is separate; see
[BACKUP-RETENTION.md](BACKUP-RETENTION.md). Database, media, backup, environment and toolchain
state must live outside the release tree and is never targeted by this lifecycle.

## Source-only delivery / activation gate

These are repository-owned scripts, **not a deployment or cleanup authorization**. Nothing
activates on build or service startup. This change has not run on a live host. Before using
it there, the owner must approve rollout, reconcile the historical multi-release inventory
and pins, verify source/script provenance, provision the deployment-owned release root,
prove service observation and `lsof` permissions, and exercise the real host smoke/recovery
path. The old fifteen-release assessment remains keep-all with **zero approved deletions**.
The scripts intentionally refuse a nonempty root without current, or any extra legacy/orphan
release: they do not opportunistically delete historical directories to make room.

## Canonical entrypoints

Run the reviewed scripts from a trusted checkout **outside** the releases directory:

```sh
bash deploy/publish-release.sh <unique-release-id> <absolute-built-artifact-directory>
bash deploy/rollback-release.sh <unique-release-id> <absolute-rebuilt-artifact-directory>
```

Prepare/rebuild source from the approved Git commit on the normal build host. This tool does
not fetch code, install GitHub credentials, restore databases, or reverse migrations.
A one-argument rollback to a retained directory is no longer supported. Both entrypoints use
`release-lifecycle.sh` and the dependency-free Node 24 `release-filesystem.mjs` guard; neither
has a separate retention policy. The latter is an internal implementation helper, not a
standalone prune command. It must only be invoked by the serialized lifecycle.

Provision an empty, real, canonical application `releases` directory for first install.
Its parent contains the sole `current` symlink and `.deployment-lock`. The release root
must belong to the deployment identity and must not be group/world writable. Root and
ancestor symlinks, traversal, protected roots, chained/escaping current, unknown release
entries, special files, hardlinks, mount crossings, private `.env` files and protected
release-root data directories are refused. Contained npm binary symlinks are allowed;
escaping/broken links are not. The legacy inventory CLI remains stricter and refuses all
in-release links, so it is not the live lifecycle validator.

Required host tools include Bash, Node 24, PostgreSQL client, `sudo`, systemd, GNU `mv -T`,
`readlink -f`, curl and `lsof`. `lsof` must have complete process visibility; missing tools,
permissions errors or other diagnostics block deletion. Readiness defaults to twelve attempts
two seconds apart; each curl has a five-second connect and ten-second total timeout. These
existing deployment environment controls are not product configuration.

## Safety and failure semantics

- Exclusive `mkdir` acquisition of the sibling `.deployment-lock` spans preflight, copy,
  dependency installation, migration/bootstrap, switch, smoke, recovery and deletion.
  Concurrent publish and rollback refuse the same lock. It is never expired or stolen.
- Existing deployments must contain exactly one selected release. Both actual systemd
  MainPIDs must resolve through `/proc/PID/cwd` to that release. Selection is rechecked before
  switching and deleting. Successful smoke checks both service activity and actual process
  release paths; a health response alone is insufficient.
- This bounded automatic-recovery path only accepts an unchanged migration tree (including
  migration metadata). A changed schema requires a separately reviewed expand/contract and
  recovery procedure. Equality does **not** certify live database compatibility, reverse a
  partial migration, or replace host/database acceptance. No database restore/delete is run.
- A `.release-pin` marker blocks automatic removal and requires owner reconciliation. Never
  remove a pin just to make a deployment pass. Existing out-of-band historical pins must be
  reconciled before activation; a JSON plan cannot silently release them.
- Before removal the exact old/candidate tree is validated; current and both live service
  references must agree with the survivor. `lsof +D` must report no users of the removed tree,
  with no diagnostics. Only that exact direct release directory is removed, never siblings.
- Failure before switch leaves current unchanged and attempts safe candidate cleanup.
  Failure after switch restores and smokes the previous release before candidate cleanup.
  Failed first installation stops both units and removes only its exact current pointer
  before safe candidate cleanup. No running release is deliberately deleted.
- Failed recovery, incomplete copy, uncertain process visibility, or blocked cleanup leaves
  evidence/artifacts and the lock intact, reports nonzero, and requires owner recovery.
  Successful candidate smoke followed by failed old cleanup **keeps the healthy candidate**;
  it does not roll back merely because cleanup failed. Normal one-release state is not
  falsely claimed in these exceptional paths.
- Kill/power loss may leave two artifacts and a lock. The next invocation refuses; the owner
  must inspect current, actual processes, database state and exact directories before resuming.
  No automatic stale-lock deletion or automatic multi-release garbage collection exists.

The concurrency boundary is a trusted deployment identity and all writers honoring the lock.
This is not a defense against a hostile root user or an unrelated deployment script. Disable
legacy writers before activation. Run outside release directories so the caller itself does
not hold the old tree open. Production service paths, privileges, root ownership and process
visibility still require host verification; fixture tests are not that verification.

## Historical audit interface

The compiled `release-retention` CLI remains read-only. `assessment`, `inspect`, and `plan`
retain their existing input validation, deterministic exact paths, allocated bytes, stale
state and unknown-pin checks. **The current-plus-three proposal policy is retired**: `plan`
always keeps all artifacts and names the serialized deployment requirement, even when old
compatibility receipts are supplied. `assessment` never reads or deletes its named paths.
Outputs always have empty `approvedDeletePaths`, no candidates and zero approved bytes.
Malformed inputs exit 1, blocked manifests exit 2. `apply` remains unsupported.

```sh
node dist/entrypoints/release-retention.js assessment /path/to/historical-assessment.json
```

## Verification

`npm test -- tests/deployment-lifecycle.test.ts tests/deployment-scripts.test.ts tests/release-retention.test.ts`
executes real temporary filesystem transitions with mocked host service/SQL commands. It
covers one-to-two-to-one success, pre/post-switch failures, failed recovery, busy/stale locks,
active/unknown old processes, stale selection, migration changes, protected sibling bytes,
legacy roots, escaping and contained links, hardlinks, immutable/repeated artifacts and
rollback delegation. No tests contact a live service or provider. Database/media bytes are
asserted unchanged; real database rollback compatibility is not claimed.
