import { lstatSync, realpathSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { assertAppendOnlyMigrations } from './migration-compatibility.mjs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalDirectory(path) {
  requireCondition(isAbsolute(path) && normalize(path) === path, 'Noncanonical directory');
  requireCondition(
    realpathSync(path) === path && lstatSync(path).isDirectory(),
    'Linked directory',
  );
}

function releasePath(root, id) {
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id), 'Invalid release id');
  return join(root, id);
}

function validateRoot(root, current) {
  canonicalDirectory(root);
  const stat = lstatSync(root);
  requireCondition(
    stat.uid === process.getuid() && (stat.mode & 0o022) === 0,
    'Release root must be deployment-owner controlled and not group/world writable',
  );
  requireCondition(basename(root) === 'releases' && dirname(root) !== '/', 'Unsafe releases root');
  requireCondition(!/^\/(etc|var\/lib)(\/|$)/.test(root), 'Protected root');
  requireCondition(
    !root
      .split('/')
      .some((part) =>
        ['media', 'backups', 'database', 'databases', 'node24', 'node_modules'].includes(part),
      ),
    'Protected root',
  );
  requireCondition(current === join(dirname(root), 'current'), 'Expected sibling current link');
}

function currentRelease(root, current) {
  try {
    requireCondition(lstatSync(current).isSymbolicLink(), 'Current must be a symlink');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const target = readlinkSync(current);
  requireCondition(target === releasePath(root, basename(target)), 'Escaping current link');
  canonicalDirectory(target);
  return target;
}

function checkTree(directory, device = lstatSync(directory).dev, root = directory, depth = 0) {
  requireCondition(depth < 64, 'Release tree too deep');
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    requireCondition(stat.dev === device, 'Release contains a mount');
    requireCondition(
      !/^\.env($|\.(?!example$))/.test(name),
      'Release contains private environment',
    );
    if (stat.isSymbolicLink()) {
      requireCondition(realpathSync(path).startsWith(root + '/'), 'Escaping release symlink');
    } else if (stat.isDirectory()) {
      checkTree(path, device, root, depth + 1);
    } else {
      requireCondition(stat.isFile() && stat.nlink === 1, 'Special or hard-linked release file');
    }
  }
}

function checkRelease(path) {
  canonicalDirectory(path);
  for (const name of ['media', 'backups', 'data', 'database', 'databases', 'node24']) {
    requireCondition(!readdirSync(path).includes(name), 'Release contains protected data');
  }
  requireCondition(lstatSync(join(path, 'package-lock.json')).isFile(), 'Not a release artifact');
  checkTree(path);
}

function assertServiceRelease(expected) {
  for (const unit of ['publish-relay-web', 'publish-relay-worker']) {
    const pid = execFileSync('systemctl', ['show', unit, '--property=MainPID', '--value'], {
      encoding: 'utf8',
    }).trim();
    requireCondition(/^[1-9][0-9]*$/.test(pid), 'Missing service process');
    const cwd = execFileSync('readlink', ['-f', '/proc/' + pid + '/cwd'], {
      encoding: 'utf8',
    }).trim();
    requireCondition(cwd === expected, 'Current/process mismatch');
  }
}

function requireUnused(target) {
  // A failed observation is not proof of no users. lsof uses 1 with empty output for none.
  // Do not use -t: it implies -w and can hide permission/observation warnings.
  const result = spawnSync('lsof', ['-nP', '-F', 'p', '+D', target], { encoding: 'utf8' });
  requireCondition(
    !result.error &&
      result.status === 1 &&
      result.stdout.trim() === '' &&
      result.stderr.trim() === '',
    'Release in use or lsof unavailable',
  );
}

function preflight(root, current, id, source) {
  validateRoot(root, current);
  const selected = currentRelease(root, current);
  const entries = readdirSync(root)
    .sort()
    .map((name) => {
      const path = releasePath(root, name);
      checkRelease(path);
      return path;
    });
  requireCondition(
    entries.length === (selected ? 1 : 0),
    'Expected exactly one current release (or empty first-install root); reconcile legacy/orphan releases',
  );
  const candidate = releasePath(root, id);
  requireCondition(!entries.includes(candidate), 'Release already exists');
  checkRelease(source);
  requireCondition(!source.startsWith(root + '/'), 'Source must be outside release root');
  assertAppendOnlyMigrations(null, source);
  if (selected) {
    requireCondition(
      !readdirSync(selected).includes('.release-pin'),
      'Pinned release requires owner recovery',
    );
    assertServiceRelease(selected);
    assertAppendOnlyMigrations(selected, source);
  }
  return selected ?? '';
}

function removeRelease(root, current, survivor, targetId) {
  validateRoot(root, current);
  canonicalDirectory(join(dirname(root), '.deployment-lock'));
  const selected = currentRelease(root, current);
  requireCondition((selected ?? '') === survivor, 'Stale current selection');
  const target = releasePath(root, targetId);
  requireCondition(target !== selected, 'Cannot remove current release');
  checkRelease(target);
  requireCondition(
    !readdirSync(target).includes('.release-pin'),
    'Pinned release requires owner recovery',
  );
  if (selected) assertServiceRelease(selected);
  requireUnused(target);
  validateRoot(root, current);
  requireCondition((currentRelease(root, current) ?? '') === survivor, 'Current changed');
  rmSync(target, { recursive: true });
}

function main() {
  const [command, root, current, ...args] = process.argv.slice(2);
  if (command === 'root' && args.length === 0) {
    validateRoot(root, current);
  } else if (command === 'preflight' && args.length === 2) {
    process.stdout.write(preflight(root, current, ...args));
  } else if (command === 'remove' && args.length === 2) {
    removeRelease(root, current, ...args);
  } else if (command === 'verify' && args.length === 1) {
    validateRoot(root, current);
    requireCondition(currentRelease(root, current) === args[0], 'Stale current selection');
    checkRelease(args[0]);
    assertServiceRelease(args[0]);
  } else if (command === 'selection' && args.length === 1) {
    validateRoot(root, current);
    requireCondition((currentRelease(root, current) ?? '') === args[0], 'Stale current selection');
  } else if (command === 'artifact' && args.length === 1) {
    validateRoot(root, current);
    checkRelease(releasePath(root, args[0]));
  } else {
    throw new Error('Unsupported release filesystem command');
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
