import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const pgAvailable =
  spawnSync('pg_dump', ['--version']).status === 0 &&
  spawnSync('initdb', ['--version']).status === 0;
function command(binary: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(binary, args, { env, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

// Real PostgreSQL on a private Unix socket; no live DB, network listener, or credentials.
// age is deliberately a reversible fixture because age is not required on development hosts.
it.skipIf(!pgAvailable).each(['encrypted', 'local'])(
  'captures/restores real PostgreSQL (%s) and rejects truncated archives',
  (mode) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-pg-backup-')));
    const data = join(root, 'data');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const env = {
      ...process.env,
      PGHOST: root,
      PGPORT: '55479',
      PGUSER: 'backup_fixture',
      PGDATABASE: 'postgres',
    };
    let started = false;
    try {
      command('initdb', ['-D', data, '-U', 'backup_fixture', '--auth=trust', '--no-locale'], env);
      command(
        'pg_ctl',
        [
          '-D',
          data,
          '-l',
          join(root, 'postgres.log'),
          '-o',
          `-F -k ${root} -h '' -p 55479`,
          '-w',
          'start',
        ],
        env,
      );
      started = true;
      command(
        'psql',
        [
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          'CREATE TABLE __drizzle_migrations(id integer); INSERT INTO __drizzle_migrations VALUES (1); CREATE TABLE fixture AS SELECT n, repeat(md5(n::text), 100) AS body FROM generate_series(1, 100) n;',
        ],
        env,
      );
      const age = join(bin, 'age');
      writeFileSync(
        age,
        '#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$1" == -d ]]; then cp "${@: -1}" "$5"; else cp "${@: -1}" "${@: -2:1}"; fi\n',
      );
      chmodSync(age, 0o755);
      const keygen = join(bin, 'age-keygen');
      writeFileSync(
        keygen,
        '#!/usr/bin/env bash\nif [[ "$1" == -y ]]; then echo ephemeral-recipient; else echo ephemeral-test-key > "$2"; fi\n',
      );
      chmodSync(keygen, 0o755);
      const backups = join(root, 'backups');
      const captureEnv = {
        ...env,
        PATH: bin + ':' + (process.env.PATH ?? ''),
        BACKUP_DIRECTORY: backups,
        MIGRATION_DATABASE_URL: 'postgresql:///postgres',
        BACKUP_AGE_RECIPIENT: mode === 'local' ? '' : 'fixture',
      };
      const path = command(
        'bash',
        [
          join(import.meta.dirname, '../deploy/backup-database.sh'),
          ...(mode === 'local' ? ['--local'] : []),
        ],
        captureEnv,
      );
      command('createdb', ['fixture_restore'], env);
      if (mode === 'local') {
        for (const target of ['postgresql:///postgres', 'postgresql:///unsafe']) {
          expect(
            spawnSync('bash', [join(import.meta.dirname, '../deploy/restore-drill.sh'), path], {
              env: { ...captureEnv, RESTORE_DATABASE_URL: target },
            }).status,
          ).toBe(65);
        }
        command('bash', [join(import.meta.dirname, '../deploy/restore-drill.sh'), path], {
          ...captureEnv,
          RESTORE_DATABASE_URL: 'postgresql:///fixture_restore',
        });
      } else {
        command(
          'pg_restore',
          ['--exit-on-error', '--no-owner', '--no-acl', '--dbname=fixture_restore', path],
          env,
        );
      }
      expect(
        command('psql', ['-d', 'fixture_restore', '-Atc', 'SELECT count(*) FROM fixture'], env),
      ).toBe('100');

      const archive = join(root, 'uncompressed.dump');
      command('pg_dump', ['--format=custom', '--compress=0', '--file', archive], env);
      const bytes = readFileSync(archive);
      const truncated = join(root, 'truncated.dump');
      writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
      expect(spawnSync('pg_restore', ['--list', truncated], { env }).status).toBe(0);
      expect(spawnSync('pg_restore', ['--file=/dev/null', truncated], { env }).status).not.toBe(0);
    } finally {
      if (started) command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], env);
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
