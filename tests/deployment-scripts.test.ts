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

import { loadRuntimeConfig } from '../src/config/runtime-config.js';

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
  const nodeBin = join(bin, 'node24');
  const npmCli = join(bin, 'npm-cli.js');
  writeFileSync(npmCli, 'fixture npm CLI');
  writeExecutable(
    nodeBin,
    'if [[ "$1" == "--version" ]]; then echo v24.8.0; exit 0; fi; shift; echo "npm $*" >> "$COMMAND_LOG"; [[ "${FAIL_MIGRATION:-0}" != 1 || "$*" != *"db:migrate:production"* ]]',
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
      PUBLISH_RELAY_NODE_BIN: nodeBin,
      PUBLISH_RELAY_NPM_CLI: npmCli,
      PUBLISH_RELAY_HEALTH_URL: 'http://127.0.0.1:3999/health/ready',
      MIGRATION_DATABASE_URL: 'postgresql://migrator@127.0.0.1/publish_relay',
    },
    source,
    currentLink,
    log,
  };
}

describe('deployment scripts', () => {
  it('provisions distinct forced-RLS web and cross-workspace worker authorities', () => {
    const content = readFileSync(
      join(projectRoot, 'deploy/bootstrap-database-authorities.sql'),
      'utf8',
    );
    expect(content).toContain('publish_relay_web');
    expect(content).toMatch(/publish_relay_web[^;]+NOBYPASSRLS/);
    expect(content).toContain('publish_relay_worker');
    expect(content).toMatch(/publish_relay_worker[^;]+BYPASSRLS/);
    expect(content).not.toMatch(/PASSWORD|CREATE ROLE [^;]+\sLOGIN(?:\s|;)/);
    expect(readFileSync(join(projectRoot, 'src/entrypoints/web.ts'), 'utf8')).toContain(
      '-c role=publish_relay_web',
    );
    expect(readFileSync(join(projectRoot, 'src/entrypoints/worker.ts'), 'utf8')).toContain(
      '-c role=publish_relay_worker',
    );
  });
  it('defaults the application listener to the isolated port and accepts an override', () => {
    expect(loadRuntimeConfig({ NODE_ENV: 'test' }).PORT).toBe(3106);
    expect(loadRuntimeConfig({ NODE_ENV: 'test', PORT: '43199' }).PORT).toBe(43199);
  });

  it('pins both services to the isolated Node 24 path and isolated health port', () => {
    for (const unit of ['publish-relay-web.service', 'publish-relay-worker.service']) {
      const content = readFileSync(join(projectRoot, 'deploy/systemd', unit), 'utf8');
      expect(content).toContain('ExecStart=/opt/publish-relay/node24/bin/node');
      expect(content).not.toContain('/usr/bin/node');
    }
    expect(
      readFileSync(join(projectRoot, 'deploy/systemd/publish-relay-web.service'), 'utf8'),
    ).toContain('publish-relay-web.env');
    expect(
      readFileSync(join(projectRoot, 'deploy/systemd/publish-relay-worker.service'), 'utf8'),
    ).toContain('publish-relay-worker.env');
    for (const script of ['publish-release.sh', 'rollback-release.sh']) {
      const content = readFileSync(join(projectRoot, 'deploy', script), 'utf8');
      expect(content).toContain('PUBLISH_RELAY_HEALTH_URL');
      expect(content).toContain('127.0.0.1:3106');
      expect(content).not.toContain('127.0.0.1:3100');
    }
  });

  it('packages the local runtime as secret-free crash-restarting launchd services', () => {
    const content = readFileSync(join(projectRoot, 'deploy/macos/publish-relay-local.sh'), 'utf8');
    expect(content).toContain('local.publish-relay.postgres');
    expect(content).toContain('<key>KeepAlive</key><true/>');
    expect(content).toContain('publish-relay/local-master-key');
    expect(content).toContain('publish-relay/local-cursor-secret');
    expect(content).toContain('publish_relay_migrator_login');
    expect(content).toContain('publish_relay_web_login');
    expect(content).toContain('publish_relay_worker_login');
    expect(content).toContain('55436');
    expect(content).toContain('3106');
    expect(content).not.toContain('/Users/');
  });

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
    expect(commands).toContain(
      'curl --fail --silent --show-error http://127.0.0.1:3999/health/ready',
    );
    expect(readlinkSync(fixture.currentLink)).toContain('release-1');
  });

  it('fails closed before install when the selected Node 24 toolchain is missing', () => {
    const fixture = createDeployFixture();
    const result = spawnSync(
      'bash',
      [join(projectRoot, 'deploy/publish-release.sh'), 'release-missing-node', fixture.source],
      {
        env: {
          ...fixture.environment,
          PUBLISH_RELAY_NODE_BIN: join(fixture.source, 'missing-node'),
        },
      },
    );
    expect(result.status).toBe(69);
    expect(() => readFileSync(fixture.log)).toThrow();
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
        MIGRATION_DATABASE_URL: databaseUrl,
        RESTORE_DATABASE_URL: databaseUrl,
        BACKUP_AGE_IDENTITY: 'identity.txt',
      },
    });
    expect(result.status).toBe(65);
    expect(() => readFileSync(marker)).toThrow();
  });
});
