import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectBackups } from '../src/modules/operations/backup-inventory.js';

const script = join(import.meta.dirname, '../deploy/backup-database.sh');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function executable(path: string, body: string) {
  writeFileSync(path, '#!/usr/bin/env bash\nset -euo pipefail\n' + body);
  chmodSync(path, 0o755);
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-backup-capture-')));
  roots.push(root);
  const bin = join(root, 'bin');
  const backups = join(root, 'backups');
  mkdirSync(bin);
  mkdirSync(backups);
  writeFileSync(join(backups, 'legacy.dump'), 'must survive');
  executable(join(bin, 'date'), 'echo 20260915T120000Z');
  executable(
    join(bin, 'age-keygen'),
    '[[ "${FAILURE:-}" != keygen ]] || exit 1; if [[ "$1" == -y ]]; then echo fixture-verification-recipient; else echo ephemeral-test-key > "$2"; fi',
  );
  executable(
    join(bin, 'pg_dump'),
    `
case "\${FAILURE:-}" in
  dump) echo partial; exit 1 ;;
  empty) exit 0 ;;
  corrupt) echo invalid; exit 0 ;;
  truncated) echo PGDMP; exit 0 ;;
esac
echo PGDMP-fixture-complete
`,
  );
  executable(
    join(bin, 'pg_restore'),
    `
echo restore >> "$LOG"
[[ "$*" == *"--file=/dev/null"* ]]
[[ "$(cat "\${@: -1}")" == PGDMP-fixture-complete ]]
`,
  );
  executable(
    join(bin, 'age'),
    `
echo age >> "$LOG"
if [[ "$1" == -d ]]; then
  [[ "\${FAILURE:-}" != decrypt ]] || exit 1
  cp "\${@: -1}" "$5"
else
  case "\${FAILURE:-}" in
    age) echo partial > "\${@: -2:1}"; exit 1 ;;
    age-empty) : > "\${@: -2:1}"; exit 0 ;;
    age-truncated) echo partial > "\${@: -2:1}"; exit 0 ;;
  esac
  cp "\${@: -1}" "\${@: -2:1}"
fi
`,
  );
  return {
    root,
    bin,
    backups,
    env: {
      ...process.env,
      PATH: bin + ':' + (process.env.PATH ?? ''),
      BACKUP_DIRECTORY: backups,
      MIGRATION_DATABASE_URL: 'postgresql://fixture/unused',
      BACKUP_AGE_RECIPIENT: 'fixture-recipient',

      LOG: join(root, 'commands.log'),
    },
  };
}
describe('atomic backup capture (injected command failure fixtures)', () => {
  it('publishes mode-0600 verified files, removes only its staging, and never prunes old backups', async () => {
    const value = fixture();
    const result = spawnSync('bash', [script], { env: value.env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const names = readdirSync(value.backups);
    expect(names).toHaveLength(3);
    expect(names.some((name) => name.startsWith('.'))).toBe(false);
    const path = result.stdout.trim();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(value.backups, 'legacy.dump'), 'utf8')).toBe('must survive');
    expect(
      (await inspectBackups(value.backups)).entries.filter((entry) => entry.verified),
    ).toHaveLength(1);
    expect(
      readFileSync(join(value.root, 'commands.log'), 'utf8').split('\n').filter(Boolean),
    ).toEqual(['restore', 'age', 'age']);
  });
  it.each([
    'dump',
    'empty',
    'corrupt',
    'truncated',
    'age',
    'age-empty',
    'age-truncated',
    'decrypt',
    'keygen',
  ])(
    'on %s failure finalizes nothing, cleans staging, and preserves every existing backup',
    (failure) => {
      const value = fixture();
      const result = spawnSync('bash', [script], {
        env: { ...value.env, FAILURE: failure },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(readdirSync(value.backups)).toEqual(['legacy.dump']);
      expect(readFileSync(join(value.backups, 'legacy.dump'), 'utf8')).toBe('must survive');
    },
  );
  it('refuses timestamp collision without overwriting an existing successful backup', () => {
    const value = fixture();
    expect(spawnSync('bash', [script], { env: value.env }).status).toBe(0);
    const before = readdirSync(value.backups).map((name) => [
      name,
      readFileSync(join(value.backups, name), 'utf8'),
    ]);
    expect(spawnSync('bash', [script], { env: value.env }).status).toBe(73);
    expect(
      readdirSync(value.backups).map((name) => [
        name,
        readFileSync(join(value.backups, name), 'utf8'),
      ]),
    ).toEqual(before);
  });
  it('refuses an existing lock without removing another capture lock', () => {
    const value = fixture();
    mkdirSync(join(value.backups, '.capture-lock'));
    expect(spawnSync('bash', [script], { env: value.env }).status).toBe(75);
    expect(readdirSync(value.backups)).toEqual(['.capture-lock', 'legacy.dump']);
  });
  it('refuses unknown arguments and missing recipient before touching the directory', () => {
    const value = fixture();
    expect(spawnSync('bash', [script, '--apply'], { env: value.env }).status).toBe(64);
    expect(
      spawnSync('bash', [script], { env: { ...value.env, BACKUP_AGE_RECIPIENT: '' } }).status,
    ).not.toBe(0);
    expect(readdirSync(value.backups)).toEqual(['legacy.dump']);
  });
});
