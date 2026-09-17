import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDeployFixture, writeExecutable } from './deployment-fixture.js';

import { loadRuntimeConfig } from '../src/config/runtime-config.js';

const projectRoot = resolve(import.meta.dirname, '..');

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
    expect(content).toContain('publish_relay_token_exchange');
    expect(content).toMatch(/publish_relay_token_exchange[^;]+BYPASSRLS/);
    expect(content).toMatch(
      /exchange_delegated_authorization_code[\s\S]+OWNER TO publish_relay_token_exchange/,
    );
    expect(content).toMatch(/GRANT SELECT ON public\.workspaces TO publish_relay_token_exchange/);
    expect(content).not.toMatch(/PASSWORD|CREATE ROLE [^;]+\sLOGIN(?:\s|;)/);
    expect(
      readFileSync(join(projectRoot, 'src/application/create-runtime-options.ts'), 'utf8'),
    ).toContain('-c role=publish_relay_web');
    expect(readFileSync(join(projectRoot, 'src/entrypoints/worker.ts'), 'utf8')).toContain(
      '-c role=publish_relay_worker',
    );
  });
  it('defaults the application listener to the isolated port and accepts an override', () => {
    expect(loadRuntimeConfig({ NODE_ENV: 'test' }).PORT).toBe(3106);
    expect(loadRuntimeConfig({ NODE_ENV: 'test', PORT: '43199' }).PORT).toBe(43199);
  });
  it('keeps provider-specific worker configuration isolated', () => {
    const worker = readFileSync(join(projectRoot, 'src/entrypoints/worker.ts'), 'utf8');
    expect(worker).toContain("event: 'provider_disabled'");
    expect(worker).toContain('if (xRuntime)');
    expect(worker).not.toContain('X runtime configuration are required for the worker');
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
    expect(content).toContain('$HOME/Library/LaunchAgents');
    expect(content).toContain('launchctl enable "$domain/$label"');
    expect(content).toContain('rm -f "$(plist_path "$label")"');
    expect(content).toContain('publish-relay/local-master-key');
    expect(content).toContain('publish-relay/local-cursor-secret');
    expect(content).toContain('publish_relay_migrator_login');
    expect(content).toContain('publish_relay_web_login');
    expect(content).toContain('publish_relay_worker_login');
    expect(content).toContain('(cd "$project_root" && DATABASE_URL=');
    expect(content).toContain('status >/dev/null 2>&1 || return 0');
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
    const releaseDirectory = join(realpathSync(fixture.releaseRoot), 'release-1');
    expect(commands).toContain('npm ci --omit=dev --ignore-scripts');
    expect(commands).toContain(
      `node=${fixture.nodeBin} cwd=${releaseDirectory} script=dist/database/migrate.js database=set password=set`,
    );
    expect(commands).toContain(
      `psql cwd=${releaseDirectory} pgdatabase=missing password=set -v ON_ERROR_STOP=1 -f deploy/bootstrap-database-authorities.sql postgresql://migrator@127.0.0.1/publish_relay`,
    );
    expect(commands).not.toContain('fixture-password');
    expect(commands.indexOf('script=dist/database/migrate.js')).toBeLessThan(
      commands.indexOf('psql cwd='),
    );
    expect(commands.indexOf('psql cwd=')).toBeLessThan(commands.indexOf('ln -s '));
    expect(commands.indexOf('ln -s ')).toBeLessThan(commands.indexOf('systemctl restart'));
    expect(commands.indexOf('systemctl restart')).toBeLessThan(
      commands.indexOf('systemctl is-active'),
    );
    expect(commands.indexOf('systemctl is-active')).toBeLessThan(commands.indexOf('curl --fail'));
    expect(commands).toContain(
      'curl --fail --silent --show-error --connect-timeout 5 --max-time 10 http://127.0.0.1:3999/health/ready',
    );
    expect(readlinkSync(fixture.currentLink)).toContain('release-1');
    expect(readFileSync(join(projectRoot, 'deploy/publish-release.sh'), 'utf8')).not.toContain(
      '--chdir',
    );
  });

  it('restores the reviewed compiled artifact after production dependency install', () => {
    const fixture = createDeployFixture();
    const sourceDist = join(fixture.source, 'dist');
    const sourceMigration = join(sourceDist, 'database', 'migrate.js');
    chmodSync(sourceDist, 0o700);
    chmodSync(join(sourceDist, 'database'), 0o700);
    chmodSync(sourceMigration, 0o600);
    execFileSync(
      'bash',
      [join(projectRoot, 'deploy/publish-release.sh'), 'release-artifact-restore', fixture.source],
      { env: { ...fixture.environment, NPM_REMOVES_DIST: '1' } },
    );
    const releaseDirectory = join(realpathSync(fixture.releaseRoot), 'release-artifact-restore');
    const releaseDist = join(releaseDirectory, 'dist');
    const releaseMigration = join(releaseDist, 'database', 'migrate.js');
    expect(existsSync(releaseMigration)).toBe(true);
    expect(statSync(releaseDist).mode & 0o050).toBe(0o050);
    expect(statSync(releaseMigration).mode & 0o040).toBe(0o040);
    expect(readFileSync(fixture.log, 'utf8')).toContain('script=dist/database/migrate.js');
    expect(readlinkSync(fixture.currentLink)).toContain('release-artifact-restore');
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

  it('retries readiness until the restarted service becomes healthy', () => {
    const fixture = createDeployFixture();
    execFileSync(
      'bash',
      [join(projectRoot, 'deploy/publish-release.sh'), 'release-readiness-retry', fixture.source],
      { env: { ...fixture.environment, READINESS_SUCCEEDS_ON_ATTEMPT: '2' } },
    );
    const commands = readFileSync(fixture.log, 'utf8');
    expect(commands.match(/curl --fail/g)).toHaveLength(2);
    expect(readlinkSync(fixture.currentLink)).toContain('release-readiness-retry');
  });

  it('fails the release when readiness remains unhealthy after bounded retries', () => {
    const fixture = createDeployFixture();
    const result = spawnSync(
      'bash',
      [join(projectRoot, 'deploy/publish-release.sh'), 'release-readiness-failure', fixture.source],
      { env: { ...fixture.environment, FAIL_READINESS: '1' }, encoding: 'utf8' },
    );
    expect(result.status).toBe(7);
    expect(result.stderr).toContain('readiness probe failed after 3 attempts');
    expect(readFileSync(fixture.log, 'utf8').match(/curl --fail/g)).toHaveLength(3);
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

  it('does not switch the current release when authority bootstrap fails', () => {
    const fixture = createDeployFixture();
    const result = spawnSync(
      'bash',
      [join(projectRoot, 'deploy/publish-release.sh'), 'release-bootstrap-failure', fixture.source],
      { env: { ...fixture.environment, FAIL_BOOTSTRAP: '1' } },
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.log, 'utf8')).toContain('psql cwd=');
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
