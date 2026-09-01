import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`);
  chmodSync(path, 0o755);
}

function createDeployFixture(): {
  environment: NodeJS.ProcessEnv;
  source: string;
  currentLink: string;
  log: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'publish-relay-deploy-'));
  const bin = join(root, 'bin');
  const source = join(root, 'source');
  const log = join(root, 'commands.log');
  const currentLink = join(root, 'current');
  mkdirSync(bin);
  mkdirSync(join(source, 'dist', 'database'), { recursive: true });
  writeFileSync(join(source, 'package-lock.json'), '{}');
  writeFileSync(join(source, 'dist', 'database', 'migrate.js'), '');
  writeExecutable(join(bin, 'install'), 'mkdir -p "${@: -1}"');
  writeExecutable(join(bin, 'chown'), 'exit 0');
  writeExecutable(join(bin, 'mv'), '[[ "$1" == "-Tf" ]] && shift; command /bin/mv "$@"');
  writeExecutable(join(bin, 'sudo'), 'shift 2; exec "$@"');
  writeExecutable(
    join(bin, 'npm'),
    'echo "npm $*" >> "$COMMAND_LOG"; [[ "${FAIL_MIGRATION:-0}" != 1 || "$*" != *"db:migrate:production"* ]]',
  );
  writeExecutable(join(bin, 'systemctl'), 'echo "systemctl $*" >> "$COMMAND_LOG"');
  writeExecutable(join(bin, 'curl'), 'echo "curl $*" >> "$COMMAND_LOG"');
  return {
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      COMMAND_LOG: log,
      PUBLISH_RELAY_RELEASE_ROOT: join(root, 'releases'),
      PUBLISH_RELAY_CURRENT_LINK: currentLink,
      PUBLISH_RELAY_SERVICE_USER: 'test-user',
    },
    source,
    currentLink,
    log,
  };
}

describe('deployment scripts', () => {
  it('uses the compiled production migration before switching the current release', () => {
    const fixture = createDeployFixture();
    execFileSync(
      'bash',
      [join(projectRoot, 'deploy/publish-release.sh'), 'release-1', fixture.source],
      {
        env: fixture.environment,
      },
    );
    const commands = readFileSync(fixture.log, 'utf8');
    expect(commands).toContain('npm ci --omit=dev --ignore-scripts');
    expect(commands).toContain('npm run db:migrate:production');
    expect(readlinkSync(fixture.currentLink)).toContain('release-1');
  });

  it('does not switch the current release when the production migration fails', () => {
    const fixture = createDeployFixture();
    const result = spawnSync(
      'bash',
      [join(projectRoot, 'deploy/publish-release.sh'), 'release-2', fixture.source],
      { env: { ...fixture.environment, FAIL_MIGRATION: '1' } },
    );
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(fixture.currentLink)).toThrow();
  });

  it('rejects a production restore target before invoking destructive tools', () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-relay-restore-'));
    const marker = join(root, 'invoked');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const command of ['age', 'pg_restore', 'psql'])
      writeExecutable(join(bin, command), `touch "${marker}"`);
    const databaseUrl = 'postgresql://user:pass@localhost/publish_relay';
    const result = spawnSync('bash', [join(projectRoot, 'deploy/restore-drill.sh'), 'backup.age'], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        DATABASE_URL: databaseUrl,
        RESTORE_DATABASE_URL: databaseUrl,
        BACKUP_AGE_IDENTITY: 'identity.txt',
      },
    });
    expect(result.status).toBe(65);
    expect(() => readFileSync(marker)).toThrow();
  });
});
