# Release retention: read-only planning

The default source policy is **current plus three explicitly verified, database-compatible
rollback releases**, plus **every explicit migration/recovery pin**, without a pin count limit.
A migration-file match, a successful build, age, Git order, or an application-only review
does not establish rollback compatibility. Pins do not count as verified rollback slots
unless they independently have the required compatibility evidence.

**This delivery has no apply/delete command, scheduler, deploy hook, or filesystem writer.**
All outputs have an empty `approvedDeletePaths` and zero approved deletion bytes.
Even a `proposal-only` output is not deletion approval. No existing deployment, rollback,
backup, database, provider, or service behavior changes.

## Advanced owner/audit interface

Build with the normal `npm run build`; the compiled entrypoint uses the existing Node 24
runtime and Zod dependency. Commands print JSON to stdout:

```sh
node dist/entrypoints/release-retention.js assessment /path/to/historical-assessment.json
node dist/entrypoints/release-retention.js inspect /application/releases
node dist/entrypoints/release-retention.js plan /path/to/inventory.json /path/to/evidence.json /path/to/fresh-inventory.json
```

Use the historical assessment command for an existing inventory, not fabricated live evidence.
It accepts `releases[{path, allocatedBytes, authorizedAction:"keep"}]` and
`approvedDeletePaths:[]`. Other historical proposal/reason fields cannot grant deletion
or rollback authority. It emits every exact path and allocated-byte count as keep, with
explicit missing-evidence blockers. It never reads the paths named in that historical file.

Exit codes: **0** inspection or policy proposal emitted; **2** blocked keep-all manifest
emitted; **1** malformed/unsafe input, failed observation, or unsupported command.
Capture stdout even on exit 2. Unknown flags, extra arguments, and `apply` are refused.

### Filesystem inspection boundaries

`inspect` is Linux/systemd-only. It reads the actual MainPID, kernel process start time,
and `/proc/PID/cwd` for the existing web and worker units, rather than treating a unit's
configured WorkingDirectory as a running-release reference. Missing processes fail closed.
Two complete observations must agree on current, processes, and release inventory.
Process/current disagreement is preserved in the inventory and blocks policy proposals.

The root must be an absolute canonical application directory ending in `/releases`.
The root and its ancestors cannot be symlinks. Protected data subtrees (`/var/lib`,
`/etc`, media, backups, databases, and toolchains) are refused.
Only direct, real release directories named `<7–40 lowercase hex commit>-r<positive number>`
are supported. The one permitted link is the application's direct `current` selection
of a release in that root; traversal, chained/escaping current links, all links within
releases (including contained links), hard-linked files, device crossings, special files,
and trees deeper than 64 levels are refused. Therefore a release with npm `node_modules/.bin`
symlinks intentionally fails inspection in this strict version. Do not remove links to
make it pass; an owner-reviewed link policy would be separate work.

Allocated bytes use filesystem `st_blocks * 512`, including directory blocks, not logical
file lengths. Only the release tree is enumerated; sibling database/media/backup/toolchain
data is never included. Fingerprints cover relative names and inode/device/mode/link-count/
size/block-count/mtime/ctime metadata, not content hashes. They detect ordinary mutation;
they are **not cryptographic integrity or compromise attestations**. Reads may update
filesystem access times; release contents, metadata used by the digest, links, and directory
membership are not intentionally changed.

The existing deploy and rollback scripts have **no common serialization protocol**.
Inspection deliberately emits `deploymentState:"unknown"`,
`serializationReceipt:null`, and `databaseStateFingerprint:null`. Equal scans do not
prove deploy idleness, successful readiness, or database compatibility. Thus unmodified
inspection output always yields a blocked keep-all plan. This is an explicit safe limit,
not a lock implementation or a claim that a live pruning tool is ready.

### Evidence and policy proposals

The authoritative schemas are in `src/modules/operations/release-retention.contract.ts`.
They reject unknown fields in policy inventories/evidence, malformed/duplicate release IDs,
unsafe paths, unknown pin/rollback IDs, and unsafe allocated totals.

An inventory includes version, canonical root, ISO observation time, current release,
web/worker PID + kernel start time + actual release ID, deployment state, serialization
receipt, database-state fingerprint, and per-release ID, allocated bytes, and fingerprint.
`inventoryDigest` in the plan is SHA-256 over the canonical state excluding observation
time; release ordering is normalized.

Evidence version 1 contains:

- `inventoryDigest`: exact binding to the inventoried filesystem/runtime/database state.
- `pinInventoryReceipt`: owner receipt attesting the complete migration/recovery pin list.
- `pins`: each has `id`, `purpose: "migration" | "recovery"`, and a durable `receipt`.
- `compatibleRollbacks`: each has `id`, `againstCurrent`,
  `againstDatabaseStateFingerprint`, `databaseCompatibility:"verified"`,
  `successfulDeployment:true`, ISO `verifiedAt`, and a durable test/owner `receipt`.

The pure planner supports attested inventories for **offline policy evaluation**. Receipt
strings are references, not authenticated signatures; JSON cannot establish their truth.
Do not manually relabel inspection's unknown fields to claim a production-safe plan.
The database-state digest must cover the owner-verified live schema/migration/configuration
boundary relevant to rollback; this tool does not query a database or obtain that proof.
A future serialized collector/apply flow and its approved evidence authority are not shipped.

Both input and fresh inventory must match the evidence digest, be no more than five minutes
old, not future-dated, and be in forward observation order. Any inventory/current/process
change, non-idle/failed/unknown deployment, absent serialization/database/pin proof, or fewer
than three applicable compatibility records produces **keep all and zero candidates**.
Compatibility must match both current and database state; future verification is ignored.
The three most recently verified compatible targets are selected (ID breaks timestamp ties).
Every pin and running release is protected beyond that set. Output paths and blocker
ordering are deterministic. A changed state requires a fresh owner review, not replay of
an old plan.

## Verification and remaining release gate

`npm test -- tests/release-retention.test.ts tests/deployment-scripts.test.ts`
exercises temporary real directories, active-oldest selection, extra pins, failed deployment,
stale plan/current/process state, missing compatibility, escaping/contained links, hard links,
protected paths, concurrent observation changes, byte accounting, repeatability, content
immutability, and the CLI's refusal to apply. Synthetic fixture receipts are not production
rollback evidence.

Before any future live deletion, separately approve and implement serialization shared by
deploy/rollback/prune, authoritative database/rollback and complete pin evidence collection,
fresh exact inventory/plan approval, and just-in-time revalidation. Preserve all migration/
recovery artifacts and independent backups. A failed deployment must never trigger pruning.
This source-only planner does not implement or authorize any of those live transitions.
