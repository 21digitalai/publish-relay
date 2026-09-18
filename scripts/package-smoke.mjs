import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const smokeRoot = mkdtempSync(join(tmpdir(), 'publish-relay-package-'));

try {
  const packJson = execFileSync('npm', ['pack', '--ignore-scripts', '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const [{ filename }] = JSON.parse(packJson);
  const tarball = join(projectRoot, filename);
  writeFileSync(
    join(smokeRoot, 'package.json'),
    JSON.stringify({ private: true, type: 'module', dependencies: {} }),
  );
  execFileSync('npm', ['install', '--ignore-scripts', tarball], {
    cwd: smokeRoot,
    stdio: 'pipe',
  });
  const packageRoot = join(smokeRoot, 'node_modules', '@21digital', 'publish-relay-core');
  const installed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (installed.version !== '0.1.5') throw new Error('Installed Core version is not pinned');
  for (const required of ['dist/ui/index.html', 'migrations/0000_identity_tenancy.sql'])
    readFileSync(join(packageRoot, required));
  await import('@21digital/publish-relay-core');
  await import('@21digital/publish-relay-core/auth');
  await import('@21digital/publish-relay-core/runtime');
  await import('@21digital/publish-relay-core/policy');
  rmSync(tarball);
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
