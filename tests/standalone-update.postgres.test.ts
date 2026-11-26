import { spawnSync } from 'node:child_process';
import {
  cpSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createDeployFixture, writeExecutable } from './deployment-fixture.js';

import { createCoreRuntime } from '../src/application/create-runtime-options.js';
import { createStandaloneApplication } from '../src/application/create-application.js';
import { loadRuntimeConfig } from '../src/config/runtime-config.js';

const adminDatabase = process.env.POSTGRES_UPDATE_TEST_URL ?? '';
const testName = 'relay_update_' + String(process.pid) + '_' + String(Date.now());
const database = adminDatabase ? new URL('/' + testName, adminDatabase).toString() : '';
const restoreDatabase = adminDatabase
  ? new URL('/' + testName + '_restore', adminDatabase).toString()
  : '';
const pgBin = process.env.POSTGRES_UPDATE_BIN ?? '';
const suite = database && pgBin ? describe : describe.skip;
const roots: string[] = [];
vi.setConfig({ testTimeout: 60000 });
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
suite('documented standalone command with real PostgreSQL', () => {
  function sql(url: string, statement: string) {
    const result = spawnSync(join(pgBin, 'psql'), [url, '-v', 'ON_ERROR_STOP=1', '-c', statement], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  }
  beforeAll(() => {
    sql(adminDatabase, 'CREATE DATABASE ' + testName);
    sql(adminDatabase, 'CREATE DATABASE ' + testName + '_restore');
    sql(
      adminDatabase,
      "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='publish_relay_web_login') THEN CREATE ROLE publish_relay_web_login LOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='publish_relay_worker_login') THEN CREATE ROLE publish_relay_worker_login LOGIN; END IF; END $$;",
    );
  }, 60000);
  beforeEach(() => {
    sql(adminDatabase, 'DROP DATABASE IF EXISTS ' + testName + ' WITH (FORCE)');
    sql(adminDatabase, 'CREATE DATABASE ' + testName);
    const migrated = spawnSync(process.execPath, ['dist/database/migrate.js'], {
      env: { ...process.env, DATABASE_URL: database },
      encoding: 'utf8',
    });
    expect(migrated.status, migrated.stderr).toBe(0);
    const bootstrapped = spawnSync(
      join(pgBin, 'psql'),
      [
        database,
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        'deploy/provision-database-roles.sql',
        '-f',
        'deploy/bootstrap-database-authorities.sql',
      ],
      { encoding: 'utf8' },
    );
    expect(bootstrapped.status, bootstrapped.stderr).toBe(0);
  }, 60000);
  afterAll(() => {
    sql(adminDatabase, 'DROP DATABASE IF EXISTS ' + testName + ' WITH (FORCE)');
    sql(adminDatabase, 'DROP DATABASE IF EXISTS ' + testName + '_restore WITH (FORCE)');
  });
  function fixture() {
    const f = createDeployFixture();
    const root = dirname(f.releaseRoot);
    roots.push(root);
    const node = process.execPath;
    const psql = join(pgBin, 'psql');
    const npmCli = process.env.POSTGRES_UPDATE_NPM_CLI;
    if (!npmCli) throw new Error('POSTGRES_UPDATE_NPM_CLI required for real candidate install');
    cpSync('package.json', join(f.source, 'package.json'));
    cpSync('package-lock.json', join(f.source, 'package-lock.json'));
    cpSync('dist/database/migrate.js', join(f.source, 'dist/database/migrate.js'));
    cpSync('migrations', join(f.source, 'migrations'), { recursive: true });
    cpSync(
      'deploy/bootstrap-database-authorities.sql',
      join(f.source, 'deploy/bootstrap-database-authorities.sql'),
    );
    const previous = join(f.releaseRoot, 'old');
    cpSync(f.source, previous, { recursive: true });
    symlinkSync(previous, f.currentLink);
    const journal = JSON.parse(
      readFileSync(join(f.source, 'migrations/meta/_journal.json'), 'utf8'),
    ) as {
      entries: { idx: number; tag: string; when: number; version: string; breakpoints: boolean }[];
    };
    const index = journal.entries.length;
    journal.entries.push({
      idx: index,
      tag: String(index).padStart(4, '0') + '_update_probe',
      when: Math.max(...journal.entries.map((e) => e.when)) + 1,
      version: '7',
      breakpoints: true,
    });
    writeFileSync(join(f.source, 'migrations/meta/_journal.json'), JSON.stringify(journal));
    writeFileSync(
      join(f.source, 'migrations', String(index).padStart(4, '0') + '_update_probe.sql'),
      'CREATE TABLE IF NOT EXISTS update_probe (id integer);',
    );
    writeExecutable(join(root, 'bin/uname'), 'echo Linux');
    writeExecutable(
      f.nodeBin,
      `if [[ "$1" == --version ]]; then echo v24.22.3; exit 0; fi
if [[ "$1" == *release-filesystem.mjs ]]; then exec "${node}" "$@"; fi
if [[ "$1" == *npm-cli.js ]]; then shift; exec "${node}" "${npmCli}" "$@"; fi
exec "${node}" "$@"`,
    );
    // The fixture models service-manager/process observations; database operations
    // and backup/restore/migrator/bootstrap below are NOT mocked.
    writeExecutable(
      join(root, 'bin/sudo'),
      'while [[ "$1" == --* ]]; do shift; done; [[ "$1" == -u ]] && shift 2; exec "$@"',
    );
    writeExecutable(join(root, 'bin/psql'), `exec "${psql}" "$@"`);
    return {
      ...f,
      root,
      previous,
      environment: {
        ...f.environment,
        PATH: join(root, 'bin') + ':' + pgBin + ':' + (process.env.PATH ?? ''),
        MIGRATION_DATABASE_URL: database,
        RESTORE_DATABASE_URL: restoreDatabase,
        BACKUP_DIRECTORY: join(root, 'backup'),
        PUBLISH_RELAY_PSQL_BIN: psql,
      },
    };
  }
  function run(f: ReturnType<typeof fixture>, extra: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', [resolve('deploy/update-release.sh'), 'new', f.source], {
      env: { ...f.environment, ...extra },
      encoding: 'utf8',
    });
  }
  it('backs up/restores, appends through canonical runner and bootstraps before activation', () => {
    const f = fixture();
    const result = run(f);
    expect(result.stderr, result.stdout).not.toContain('ERROR');
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(f.releaseRoot)).toEqual(['new']);
    const probe = spawnSync(
      join(pgBin, 'psql'),
      [
        database,
        '-Atc',
        "select to_regclass('public.update_probe'), has_table_privilege('publish_relay_web','public.update_probe','SELECT')",
      ],
      { encoding: 'utf8' },
    );
    expect(probe.stdout).toContain('update_probe|t');
    expect(readlinkSync(f.currentLink)).toBe(join(f.releaseRoot, 'new'));
    expect(readFileSync(f.log, 'utf8')).toContain(
      'systemctl restart publish-relay-web publish-relay-worker',
    );
  }, 60000);
  it('runs the unchanged prior application against the forward-migrated schema without reverse SQL', async () => {
    const f = fixture();
    expect(run(f).status).toBe(0);
    vi.stubEnv('PUBLISH_RELAY_MASTER_KEY_test', Buffer.alloc(32, 1).toString('base64'));
    const runtime = await createCoreRuntime(
      loadRuntimeConfig({
        NODE_ENV: 'test',
        CURSOR_SIGNING_SECRET: 'test-cursor-secret-000000000000000000',
        DATABASE_URL: database,
        PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION: 'test',
        MEDIA_STORAGE_ROOT: f.root,
        PUBLISH_RELAY_ENABLED_ADAPTERS: '',
      }),
    );
    const app = createStandaloneApplication(runtime.options);
    try {
      expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/login' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/v1/destinations' })).statusCode).toBe(
        401,
      );
      const probe = spawnSync(
        join(pgBin, 'psql'),
        [database, '-Atc', "select to_regclass('public.update_probe')"],
        { encoding: 'utf8' },
      );
      expect(probe.stdout).toContain('update_probe');
    } finally {
      await app.close();
      await runtime.close();
      vi.unstubAllEnvs();
    }
  });
  it.each(['backup', 'restore', 'migration', 'health'])(
    'stops safely on %s failure',
    (kind) => {
      const f = fixture();
      if (kind === 'backup') writeExecutable(join(f.root, 'bin/pg_dump'), 'exit 1');
      if (kind === 'restore')
        writeExecutable(
          join(f.root, 'bin/pg_restore'),
          `for arg in "$@"; do [[ "$arg" != --dbname ]] || exit 1; done; exec "${join(pgBin, 'pg_restore')}" "$@"`,
        );
      if (kind === 'migration') {
        const sqlName = readdirSync(join(f.source, 'migrations')).find((name) =>
          name.endsWith('_update_probe.sql'),
        );
        if (!sqlName) throw new Error('Missing appended fixture SQL');
        writeFileSync(join(f.source, 'migrations', sqlName), 'INVALID SQL FOR FAILURE PROOF;');
      }
      const result = run(f, kind === 'health' ? { FAIL_RELEASE: '/new' } : {});
      expect(result.status).not.toBe(0);
      expect(readlinkSync(f.currentLink)).toBe(f.previous);
      expect(readdirSync(f.releaseRoot)).toEqual(['old']);
      const schema = spawnSync(
        join(pgBin, 'psql'),
        [database, '-Atc', "select coalesce(to_regclass('public.update_probe')::text,'none')"],
        { encoding: 'utf8' },
      );
      expect(schema.status, schema.stderr).toBe(0);
      expect(schema.stdout.trim()).toBe(kind === 'health' ? 'update_probe' : 'none');
      if (kind === 'health')
        expect(readFileSync(f.log, 'utf8').match(/systemctl restart/g)).toHaveLength(2);
    },
    60000,
  );
});
