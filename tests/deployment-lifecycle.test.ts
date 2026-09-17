import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeployFixture, writeExecutable } from './deployment-fixture.js';

const deploy = join(import.meta.dirname, '../deploy/publish-release.sh');
const guard = join(import.meta.dirname, '../deploy/release-filesystem.mjs');
const roots: string[] = [];
const hostLsof = spawnSync('which', ['lsof'], { encoding: 'utf8' }).stdout.trim();
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const value = createDeployFixture();
  const root = dirname(value.releaseRoot);
  roots.push(root);
  const previous = join(value.releaseRoot, 'old');
  cpSync(value.source, previous, { recursive: true });
  symlinkSync(previous, value.currentLink);
  for (const name of ['database', 'media', 'backups', 'node24']) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'protected'), 'original bytes');
  }
  return { ...value, root, previous };
}

function run(value: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv = {}, script = deploy) {
  return spawnSync('bash', [script, 'new', value.source], {
    env: { ...value.environment, ...env },
    encoding: 'utf8',
  });
}

function assertProtected(value: ReturnType<typeof fixture>) {
  for (const name of ['database', 'media', 'backups', 'node24']) {
    expect(readFileSync(join(value.root, name, 'protected'), 'utf8')).toBe('original bytes');
  }
}

describe('serialized one-release deployment lifecycle', () => {
  it('holds at most two releases, switches then smokes, removes old, and preserves durable data', () => {
    const value = fixture();
    // Observe the actual filesystem at the external readiness boundary.
    writeExecutable(
      join(value.root, 'bin/curl'),
      '[[ "$(ls "$PUBLISH_RELAY_RELEASE_ROOT" | wc -l)" -eq 2 ]]; [[ "$(/usr/bin/readlink "$PUBLISH_RELAY_CURRENT_LINK")" == */new ]]',
    );
    const result = run(value);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readdirSync(value.releaseRoot)).toEqual(['new']);
    expect(readlinkSync(value.currentLink)).toBe(join(value.releaseRoot, 'new'));
    expect(existsSync(join(value.root, '.deployment-lock'))).toBe(false);
    assertProtected(value);
  }, 10_000);

  it.each(['FAIL_MIGRATION', 'FAIL_BOOTSTRAP'])(
    'cleans the failed candidate before switch on %s',
    (flag) => {
      const value = fixture();
      expect(run(value, { [flag]: '1' }).status).not.toBe(0);
      expect(readdirSync(value.releaseRoot)).toEqual(['old']);
      expect(readlinkSync(value.currentLink)).toBe(value.previous);
      expect(existsSync(join(value.root, '.deployment-lock'))).toBe(false);
      assertProtected(value);
    },
    10_000,
  );

  it('reverts and verifies old after candidate readiness failure, then removes only candidate', () => {
    const value = fixture();
    const result = run(value, { FAIL_RELEASE: '/new' });
    expect(result.status).toBe(7);
    expect(readdirSync(value.releaseRoot)).toEqual(['old']);
    expect(readlinkSync(value.currentLink)).toBe(value.previous);
    expect(readFileSync(value.log, 'utf8').match(/systemctl restart/g)).toHaveLength(2);
    expect(existsSync(join(value.root, '.deployment-lock'))).toBe(false);
    assertProtected(value);
  });

  it.each(['FAIL_READINESS', 'FAIL_RESTART'])(
    'preserves both releases and lock if recovery also fails: %s',
    (flag) => {
      const value = fixture();
      const result = run(value, { [flag]: '1' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Recovery failed');
      expect(readdirSync(value.releaseRoot).sort()).toEqual(['new', 'old']);
      expect(existsSync(join(value.root, '.deployment-lock'))).toBe(true);
      assertProtected(value);
    },
  );

  it.each(['OLD_IN_USE', 'LSOF_ERROR'])(
    'does not delete an active or unobservable old release: %s',
    (flag) => {
      const value = fixture();
      const result = run(value, { [flag]: '1' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Old release cleanup blocked');
      expect(readlinkSync(value.currentLink)).toBe(join(value.releaseRoot, 'new'));
      expect(readdirSync(value.releaseRoot).sort()).toEqual(['new', 'old']);
      expect(existsSync(join(value.root, '.deployment-lock'))).toBe(true);
      assertProtected(value);
    },
    10_000,
  );

  it('refuses concurrent starts and never steals even an apparently stale lock', () => {
    const value = fixture();
    mkdirSync(join(value.root, '.deployment-lock'));
    expect(run(value).status).toBe(75);
    expect(run(value, {}, join(import.meta.dirname, '../deploy/rollback-release.sh')).status).toBe(
      75,
    );
    expect(readdirSync(value.releaseRoot)).toEqual(['old']);
  });

  it('rejects an interrupted multi-release root, missing current, and migration changes before copy', () => {
    const value = fixture();
    cpSync(value.source, join(value.releaseRoot, 'orphan'), { recursive: true });
    expect(run(value).stderr).toContain('reconcile legacy/orphan');
    rmSync(join(value.releaseRoot, 'orphan'), { recursive: true });
    rmSync(value.currentLink);
    expect(run(value).status).not.toBe(0);
    symlinkSync(value.previous, value.currentLink);
    writeFileSync(
      join(value.source, 'migrations/new.sql'),
      'alter table example add column x int;',
    );
    expect(run(value).stderr).toContain('Migration set changes');
    expect(readdirSync(value.releaseRoot)).toEqual(['old']);
    assertProtected(value);
  });

  it('preserves explicitly pinned code without creating another release', () => {
    const value = fixture();
    writeFileSync(join(value.previous, '.release-pin'), 'owner recovery pending');
    expect(run(value).stderr).toContain('Pinned release');
    expect(readdirSync(value.releaseRoot)).toEqual(['old']);
    assertProtected(value);
  });

  it('accepts unchanged nested migration metadata but refuses altered journal bytes', () => {
    const value = fixture();
    for (const directory of [value.previous, value.source]) {
      mkdirSync(join(directory, 'migrations/meta'));
      writeFileSync(join(directory, 'migrations/meta/_journal.json'), '{}');
    }
    writeFileSync(join(value.source, 'migrations/meta/_journal.json'), '{"changed":true}');
    expect(run(value).stderr).toContain('Migration set changes');
    writeFileSync(join(value.source, 'migrations/meta/_journal.json'), '{}');
    expect(run(value).status).toBe(0);
    expect(readdirSync(value.releaseRoot)).toEqual(['new']);
  });

  it('does not overwrite a foreign current selection introduced during smoke', () => {
    const value = fixture();
    writeExecutable(
      join(value.root, 'bin/curl'),
      'rm "$PUBLISH_RELAY_CURRENT_LINK"; /bin/ln -s "$FOREIGN_PATH" "$PUBLISH_RELAY_CURRENT_LINK"',
    );
    expect(run(value, { FOREIGN_PATH: join(value.root, 'media') }).status).not.toBe(0);
    expect(readlinkSync(value.currentLink)).toBe(join(value.root, 'media'));
    expect(readdirSync(value.releaseRoot).sort()).toEqual(['new', 'old']);
    expect(existsSync(join(value.root, '.deployment-lock'))).toBe(true);
    assertProtected(value);
  });

  it('refuses escaping links, protected data, and hard links before copy', () => {
    const value = fixture();
    const unsafe = join(value.source, 'unsafe');
    symlinkSync(join(value.root, 'media'), unsafe);
    expect(run(value).stderr).toContain('Escaping release symlink');
    rmSync(unsafe);
    linkSync(join(value.root, 'media/protected'), unsafe);
    expect(run(value).stderr).toContain('hard-linked');
    rmSync(unsafe);
    mkdirSync(join(value.source, 'backups'));
    expect(run(value).stderr).toContain('protected data');
    expect(readdirSync(value.releaseRoot)).toEqual(['old']);
    assertProtected(value);
  });

  it('permits contained npm binary links without following them during cleanup', () => {
    const value = fixture();
    mkdirSync(join(value.previous, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(value.previous, 'node_modules/tool.js'), 'code');
    symlinkSync('../tool.js', join(value.previous, 'node_modules/.bin/tool'));
    expect(run(value).status).toBe(0);
    expect(readdirSync(value.releaseRoot)).toEqual(['new']);
    assertProtected(value);
  });

  it('refuses stale current or process evidence at the deletion boundary', () => {
    const value = fixture();
    mkdirSync(join(value.root, '.deployment-lock'));
    cpSync(value.source, join(value.releaseRoot, 'new'), { recursive: true });
    const invoke = (survivor: string, env: NodeJS.ProcessEnv = {}) =>
      spawnSync(
        process.execPath,
        [guard, 'remove', value.releaseRoot, value.currentLink, survivor, 'new'],
        { env: { ...value.environment, ...env }, encoding: 'utf8' },
      );
    expect(invoke(join(value.releaseRoot, 'new')).stderr).toContain('Stale current');
    expect(invoke(value.previous, { PROCESS_MISMATCH: '1' }).stderr).toContain(
      'Current/process mismatch',
    );
    expect(readdirSync(value.releaseRoot).sort()).toEqual(['new', 'old']);
    assertProtected(value);
  });

  it.skipIf(!hostLsof)(
    'uses real lsof to protect a live process cwd and removes only after it exits',
    async () => {
      const value = fixture();
      mkdirSync(join(value.root, '.deployment-lock'));
      const candidate = join(value.releaseRoot, 'new');
      cpSync(value.source, candidate, { recursive: true });
      writeExecutable(join(value.root, 'bin/lsof'), 'exec "$HOST_LSOF" "$@"');
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000); console.log("ready")'],
        { cwd: candidate },
      );
      try {
        await once(child.stdout, 'data');
        const remove = () =>
          spawnSync(
            process.execPath,
            [guard, 'remove', value.releaseRoot, value.currentLink, value.previous, 'new'],
            { env: { ...value.environment, HOST_LSOF: hostLsof }, encoding: 'utf8' },
          );
        expect(remove().stderr).toContain('Release in use');
        expect(existsSync(candidate)).toBe(true);
        const closed = once(child, 'close');
        child.kill();
        await closed;
        expect(remove().status).toBe(0);
        expect(readdirSync(value.releaseRoot)).toEqual(['old']);
        assertProtected(value);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close');
          child.kill();
          await closed;
        }
      }
    },
  );

  it('rebuild rollback delegates to the same transaction and a repeated release ID does not mutate it', () => {
    const value = fixture();
    expect(run(value, {}, join(import.meta.dirname, '../deploy/rollback-release.sh')).status).toBe(
      0,
    );
    const before = readFileSync(join(value.releaseRoot, 'new/package-lock.json'));
    expect(run(value).status).not.toBe(0);
    expect(readFileSync(join(value.releaseRoot, 'new/package-lock.json'))).toEqual(before);
    expect(readdirSync(value.releaseRoot)).toEqual(['new']);
    assertProtected(value);
  }, 10_000);
});
