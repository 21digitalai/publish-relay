#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 0 ]]; then
  echo "usage: $0 (capture only; retention has no apply command)" >&2
  exit 64
fi
: "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"
backup_directory="${BACKUP_DIRECTORY:-/var/backups/publish-relay}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_directory}/publish-relay-${timestamp}.dump.age"

for tool in pg_dump pg_restore age age-keygen node cmp; do
  command -v "$tool" >/dev/null || { echo "missing required backup tool: $tool" >&2; exit 69; }
done
[[ ! -L "$backup_directory" ]] || { echo "backup root must not be a symlink" >&2; exit 65; }
install -d -m 0700 "$backup_directory"
# Exclusive capture lock. Never remove a lock owned by another invocation.
lock="${backup_directory}/.capture-lock"
mkdir "$lock" || { echo "backup capture already locked; inspect abandoned capture before retry" >&2; exit 75; }
stage=""
cleanup() {
  if [[ -n "$stage" ]]; then
    rm -f "$stage/raw.dump" "$stage/encrypted.age" "$stage/roundtrip.dump" "$stage/receipt.json" "$stage/verification.key"
    rmdir "$stage"
  fi
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
stage="$(mktemp -d "${backup_directory}/.capture-XXXXXXXX")"
[[ ! -e "$target" && ! -L "$target" && ! -e "${target}.verified.json" && ! -L "${target}.verified.json" ]] ||
  { echo "backup timestamp collision; existing backup preserved" >&2; exit 73; }

pg_dump --format=custom --no-owner --no-acl "$MIGRATION_DATABASE_URL" > "$stage/raw.dump"
[[ -s "$stage/raw.dump" ]] || { echo "empty database backup refused" >&2; exit 65; }
# Full archive traversal catches truncated data that pg_restore --list can miss.
pg_restore --no-owner --no-acl --file=/dev/null "$stage/raw.dump"
# A disposable second recipient proves encryption without bringing the recovery key here.
age-keygen -o "$stage/verification.key" 2>/dev/null
verification_recipient="$(age-keygen -y "$stage/verification.key")"
age -r "$BACKUP_AGE_RECIPIENT" -r "$verification_recipient" -o "$stage/encrypted.age" "$stage/raw.dump"
[[ -s "$stage/encrypted.age" ]] || { echo "empty encrypted backup refused" >&2; exit 65; }
age -d -i "$stage/verification.key" -o "$stage/roundtrip.dump" "$stage/encrypted.age"
cmp -s "$stage/raw.dump" "$stage/roundtrip.dump" ||
  { echo "encrypted backup round-trip mismatch" >&2; exit 65; }
node --input-type=module - "$stage/encrypted.age" "$target" > "$stage/receipt.json" <<'NODE'
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
const [source, target] = process.argv.slice(2);
const hash = createHash('sha256');
for await (const chunk of createReadStream(source)) hash.update(chunk);
process.stdout.write(JSON.stringify({
  version: 1, file: basename(target), bytes: statSync(source).size,
  sha256: hash.digest('hex'), validation: 'pg-restore-full-and-age-roundtrip',
  validatedAt: new Date().toISOString()
}) + '\n');
NODE
# Same-filesystem hard links publish complete bytes atomically without overwriting.
# A crash between links leaves an unreceipted backup, which the planner keeps.
ln "$stage/encrypted.age" "$target"
ln "$stage/receipt.json" "${target}.verified.json"
echo "$target"
# No find/delete, automatic pruning, or retention apply: existing backups stay intact.
