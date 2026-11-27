#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = '@21digital/publish-relay-core';
const migrationSupportFiles = [
  'deploy/known-history-transition.mjs',
  'deploy/known-history-main-20261127.json',
  'deploy/migration-compatibility.mjs',
];
const exportsMap = {
  './package.json': './package.json',
  './application': {
    types: './dist/package-entrypoints/application.d.ts',
    import: './dist/package-entrypoints/application.js',
  },
  './runtime': {
    types: './dist/package-entrypoints/runtime.d.ts',
    import: './dist/package-entrypoints/runtime.js',
  },
  './auth': {
    types: './dist/package-entrypoints/auth.d.ts',
    import: './dist/package-entrypoints/auth.js',
  },
  './policy': {
    types: './dist/modules/policy/action-policy.d.ts',
    import: './dist/modules/policy/action-policy.js',
  },
};

function command(binary, args, cwd = root) {
  return execFileSync(binary, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !['--output-dir', '--hosted-dir', '--release-id', '--expected-commit'].includes(key) ||
      !value
    ) {
      throw new Error(
        'usage: npm run package:hosted -- --output-dir DIR --expected-commit FULL_SHA [--hosted-dir DIR --release-id ID]',
      );
    }
    options[key] = value;
  }
  if (!options['--output-dir'] || !/^[a-f0-9]{40}$/.test(options['--expected-commit'] ?? '')) {
    throw new Error('--output-dir and a full --expected-commit are required');
  }
  if (Boolean(options['--hosted-dir']) !== Boolean(options['--release-id'])) {
    throw new Error('--hosted-dir requires --release-id, and vice versa');
  }
  return options;
}

async function hashFile(path, algorithm = 'sha256') {
  return createHash(algorithm)
    .update(await readFile(path))
    .digest('hex');
}

async function listFiles(directory, prefix = '') {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) paths.push(...(await listFiles(join(directory, entry.name), name)));
    else if (entry.isFile()) paths.push(name);
    else throw new Error(`Unexpected migration entry: ${name}`);
  }
  return paths.sort();
}

async function verifyMigrations(source, packaged) {
  const expected = await listFiles(source);
  const actual = await listFiles(packaged);
  if (
    JSON.stringify(expected) !== JSON.stringify(actual) ||
    !expected.includes(join('meta', '_journal.json'))
  ) {
    throw new Error('Packaged migration tree differs from source');
  }
  for (const path of expected) {
    if ((await hashFile(join(source, path))) !== (await hashFile(join(packaged, path)))) {
      throw new Error(`Packaged migration differs: ${path}`);
    }
  }
  return expected.length;
}

function assertSource(expectedCommit) {
  const actual = command('git', ['rev-parse', 'HEAD']);
  if (actual !== expectedCommit)
    throw new Error(`Expected Core commit ${expectedCommit}, found ${actual}`);
  if (command('git', ['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('Core source must be clean before packaging');
  }
}

async function writePackage(staging, sourcePackage, commit) {
  const metadata = {
    ...sourcePackage,
    name: PACKAGE_NAME,
    private: false,
    publishRelaySourceCommit: commit,
    exports: exportsMap,
    files: ['dist', 'migrations', ...migrationSupportFiles, 'LICENSE'],
  };
  delete metadata.scripts;
  delete metadata.devDependencies;
  delete metadata.overrides;
  await mkdir(join(staging, 'deploy'));
  await Promise.all([
    ...migrationSupportFiles.map((path) => cp(join(root, path), join(staging, path))),
    cp(join(root, 'dist'), join(staging, 'dist'), { recursive: true }),
    cp(join(root, 'migrations'), join(staging, 'migrations'), { recursive: true }),
    cp(join(root, 'LICENSE'), join(staging, 'LICENSE')),
    writeFile(join(staging, 'package.json'), JSON.stringify(metadata, null, 2) + '\n'),
  ]);
  for (const value of Object.values(exportsMap)) {
    if (typeof value !== 'object') continue;
    await Promise.all(Object.values(value).map((path) => readFile(join(staging, path.slice(2)))));
  }
}

async function verifyFreshInstall(artifact, staging, commit) {
  const consumer = join(staging, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  command(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(staging, 'fresh-cache'),
      artifact,
    ],
    consumer,
  );
  const installed = join(consumer, 'node_modules', '@21digital', 'publish-relay-core');
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  if (metadata.name !== PACKAGE_NAME || metadata.publishRelaySourceCommit !== commit) {
    throw new Error('Fresh install has the wrong package identity or source commit');
  }
  const count = await verifyMigrations(join(root, 'migrations'), join(installed, 'migrations'));
  for (const path of migrationSupportFiles) {
    if ((await hashFile(join(root, path))) !== (await hashFile(join(installed, path)))) {
      throw new Error(`Fresh install changed migration support file: ${path}`);
    }
  }
  command(
    'node',
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(join(installed, 'deploy/known-history-transition.mjs'))})`,
    ],
    consumer,
  );
  for (const entry of ['application', 'runtime', 'auth', 'policy']) {
    command(
      'node',
      ['--input-type=module', '-e', `await import("${PACKAGE_NAME}/${entry}")`],
      consumer,
    );
  }
  return count;
}

async function updateHosted(hosted, artifact, sourcePackage, commit, releaseId, staging) {
  const manifestPath = join(hosted, 'release-manifest.json');
  const packagePath = join(hosted, 'package.json');
  const lockPath = join(hosted, 'package-lock.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const hostedPackage = JSON.parse(await readFile(packagePath, 'utf8'));
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const vendorName = `21digital-publish-relay-core-${sourcePackage.version}.tgz`;
  const vendorPath = join(hosted, 'vendor', vendorName);
  const reference = `file:vendor/${vendorName}`;
  if (
    manifest.core.version === sourcePackage.version ||
    command('git', ['status', '--porcelain'], hosted)
  ) {
    throw new Error(
      'Hosted must be clean and the package version must advance; existing staged archive is immutable',
    );
  }
  if (Object.keys(hostedPackage.dependencies).includes(PACKAGE_NAME) === false) {
    throw new Error('Hosted has no Core dependency to update');
  }
  manifest.releaseId = releaseId;
  manifest.core.version = sourcePackage.version;
  manifest.core.commit = commit;
  manifest.core.artifactSha256 = await hashFile(artifact);
  hostedPackage.dependencies[PACKAGE_NAME] = reference;
  lock.packages[''].dependencies[PACKAGE_NAME] = reference;
  const locked = lock.packages[`node_modules/${PACKAGE_NAME}`];
  if (!locked) throw new Error('Hosted lockfile has no Core package entry');
  locked.version = sourcePackage.version;
  locked.resolved = reference;
  locked.integrity = `sha512-${createHash('sha512')
    .update(await readFile(artifact))
    .digest('base64')}`;
  locked.dependencies = sourcePackage.dependencies;
  const candidate = join(staging, 'hosted-candidate');
  await mkdir(join(candidate, 'vendor'), { recursive: true });
  await cp(artifact, join(candidate, 'vendor', vendorName));
  await Promise.all([
    writeFile(join(candidate, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n'),
    writeFile(join(candidate, 'package.json'), JSON.stringify(hostedPackage, null, 2) + '\n'),
    writeFile(join(candidate, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n'),
  ]);
  command(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(staging, 'npm-cache'),
    ],
    candidate,
  );
  const finalLock = JSON.parse(await readFile(join(candidate, 'package-lock.json'), 'utf8'));
  if (finalLock.packages[`node_modules/${PACKAGE_NAME}`]?.integrity !== locked.integrity) {
    throw new Error('npm changed the Core artifact integrity during lock refresh');
  }
  await mkdir(dirname(vendorPath), { recursive: true });
  await cp(join(candidate, 'vendor', vendorName), vendorPath);
  await Promise.all([
    cp(join(candidate, 'release-manifest.json'), manifestPath),
    cp(join(candidate, 'package.json'), packagePath),
    cp(join(candidate, 'package-lock.json'), lockPath),
  ]);
  return vendorPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const commit = options['--expected-commit'];
  const output = resolve(options['--output-dir']);
  assertSource(commit);
  const sourcePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  command('npm', ['run', 'build']);
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(tmpdir(), 'publish-relay-package-'));
  try {
    const packageRoot = join(staging, 'package');
    await mkdir(packageRoot);
    await writePackage(packageRoot, sourcePackage, commit);
    const packed = JSON.parse(
      command('npm', ['pack', '--json', '--pack-destination', output], packageRoot),
    );
    const artifact = join(output, basename(packed[0].filename));
    const migrationCount = await verifyFreshInstall(artifact, staging, commit);
    let vendorPath;
    if (options['--hosted-dir']) {
      vendorPath = await updateHosted(
        resolve(options['--hosted-dir']),
        artifact,
        sourcePackage,
        commit,
        options['--release-id'],
        staging,
      );
    }
    console.log(
      JSON.stringify({
        artifact,
        sha256: await hashFile(artifact),
        commit,
        migrationCount,
        vendorPath,
      }),
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
