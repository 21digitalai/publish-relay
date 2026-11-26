import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'migration-guard-'));
  roots.push(root);
  const old = join(root, 'old');
  const next = join(root, 'next');
  mkdirSync(join(old, 'migrations/meta'), { recursive: true });
  const journal = {
    version: '7',
    dialect: 'postgresql',
    entries: [{ idx: 0, version: '7', when: 100, tag: '0000_initial', breakpoints: true }],
  };
  writeFileSync(join(old, 'migrations/0000_initial.sql'), 'select 1;');
  writeFileSync(join(old, 'migrations/meta/_journal.json'), JSON.stringify(journal));
  cpSync(old, next, { recursive: true });
  function save() {
    writeFileSync(join(next, 'migrations/meta/_journal.json'), JSON.stringify(journal));
  }
  function append() {
    journal.entries.push({ idx: 1, version: '7', when: 101, tag: '0001_added', breakpoints: true });
    save();
    writeFileSync(join(next, 'migrations/0001_added.sql'), 'select 2;');
  }
  function run() {
    return spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {assertAppendOnlyMigrations as check} from ${JSON.stringify(resolve('deploy/migration-compatibility.mjs'))}; check(process.argv[1],process.argv[2]);`,
        old,
        next,
      ],
      { encoding: 'utf8' },
    );
  }
  return { old, next, journal, save, append, run };
}
describe('strict standalone append-only migration guard', () => {
  it('accepts equal and genuine appended SQL plus journal', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    f.append();
    expect(f.run().status).toBe(0);
  });
  it.each([
    'edit',
    'delete',
    'rename',
    'symlink',
    'extra-dir',
    'extra-sql',
    'journal-only',
    'reorder',
    'duplicate',
    'timestamp',
    'root-metadata',
    'snapshot',
    'malformed',
    'downgrade',
  ])('rejects %s', (kind) => {
    const f = fixture();
    f.append();
    const oldSql = join(f.next, 'migrations/0000_initial.sql');
    if (kind === 'edit') writeFileSync(oldSql, 'select 3;');
    if (kind === 'delete') rmSync(oldSql);
    if (kind === 'rename') renameSync(oldSql, join(f.next, 'migrations/0000_renamed.sql'));
    if (kind === 'symlink') {
      rmSync(oldSql);
      symlinkSync(join(f.old, 'migrations/0000_initial.sql'), oldSql);
    }
    if (kind === 'extra-dir') mkdirSync(join(f.next, 'migrations/other'));
    if (kind === 'extra-sql')
      writeFileSync(join(f.next, 'migrations/0002_orphan.sql'), 'select 3;');
    if (kind === 'journal-only') rmSync(join(f.next, 'migrations/0001_added.sql'));
    if (kind === 'reorder') {
      f.journal.entries.reverse();
      f.save();
    }
    if (kind === 'duplicate') {
      Object.assign(f.journal.entries[1] ?? {}, { idx: 0 });
      f.save();
    }
    if (kind === 'timestamp') {
      Object.assign(f.journal.entries[1] ?? {}, { when: 99 });
      f.save();
    }
    if (kind === 'root-metadata') {
      f.journal.version = '8';
      f.save();
    }
    if (kind === 'snapshot')
      writeFileSync(join(f.next, 'migrations/meta/0000_snapshot.json'), '{}');
    if (kind === 'malformed') writeFileSync(join(f.next, 'migrations/meta/_journal.json'), '{');
    if (kind === 'downgrade') {
      f.journal.entries = [];
      f.save();
    }
    expect(f.run().status).not.toBe(0);
  });
  it('accepts a matching new snapshot but refuses a malformed one', () => {
    const f = fixture();
    f.append();
    const path = join(f.next, 'migrations/meta/0001_snapshot.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        id: '00000000-0000-0000-0000-000000000001',
        prevId: '00000000-0000-0000-0000-000000000000',
        tables: {},
      }),
    );
    expect(f.run().status).toBe(0);
    writeFileSync(path, JSON.stringify({ dialect: 'postgresql' }));
    expect(f.run().status).not.toBe(0);
  });
  it('refuses metadata-only edits even if JSON is semantically equal', () => {
    const f = fixture();
    writeFileSync(
      join(f.next, 'migrations/meta/_journal.json'),
      readFileSync(join(f.old, 'migrations/meta/_journal.json'), 'utf8') + '\n',
    );
    expect(f.run().status).not.toBe(0);
  });
});
