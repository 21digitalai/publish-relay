import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  inventoryDigest,
  releaseId,
  validateInventory,
  validateRoot,
} from './release-retention.contract.js';
import type { ReleaseInventory } from './release-retention.contract.js';

const BLOCK_BYTES = 512;
const MAX_TREE_DEPTH = 64;
type RuntimeObserver = (root: string) => ReleaseInventory['processes'];

function inspectTree(
  path: string,
  device: bigint,
  depth = 0,
): {
  allocatedBytes: number;
  fingerprint: string;
} {
  if (depth > MAX_TREE_DEPTH) throw new Error('Release tree exceeds safe inspection depth');
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error('Symlinks and special files are refused in releases');
  }
  if (stat.dev !== device || (stat.isFile() && stat.nlink !== 1n)) {
    throw new Error('Mounted or hard-linked release content is refused');
  }
  const hash = createHash('sha256').update(
    [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.nlink,
      stat.size,
      stat.blocks,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join(':'),
  );
  let allocatedBytes = Number(stat.blocks) * BLOCK_BYTES;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      const child = inspectTree(join(path, name), device, depth + 1);
      allocatedBytes += child.allocatedBytes;
      hash.update(JSON.stringify([name, child.fingerprint]));
    }
  }
  if (!Number.isSafeInteger(allocatedBytes)) throw new Error('Allocated-byte overflow');
  return { allocatedBytes, fingerprint: hash.digest('hex') };
}

function releaseForPath(root: string, path: string): string {
  if (dirname(path) !== root) throw new Error('Runtime reference escapes release root');
  return releaseId.parse(basename(path));
}

function observeSystemd(root: string): ReleaseInventory['processes'] {
  function observe(unit: string) {
    const pidText = execFileSync(
      '/usr/bin/systemctl',
      ['show', unit, '--property=MainPID', '--value'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 },
    ).trim();
    if (!/^[1-9][0-9]*$/.test(pidText)) throw new Error('Service has no live main process');
    const processRoot = `/proc/${pidText}`;
    const stat = readFileSync(join(processRoot, 'stat'), 'utf8');
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (!startTime || !/^[0-9]+$/.test(startTime)) throw new Error('Missing process start time');
    return {
      pid: Number(pidText),
      startTime,
      releaseId: releaseForPath(root, realpathSync(join(processRoot, 'cwd'))),
    };
  }
  return {
    web: observe('publish-relay-web.service'),
    worker: observe('publish-relay-worker.service'),
  };
}

function inspectOnce(root: string, observe: RuntimeObserver): ReleaseInventory {
  validateRoot(root);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) {
    throw new Error('Release root or ancestor is a symlink or not a directory');
  }
  const currentLink = join(dirname(root), 'current');
  if (!lstatSync(currentLink).isSymbolicLink()) throw new Error('Current must be a symlink');
  const target = readlinkSync(currentLink);
  const resolvedTarget = resolve(dirname(root), target);
  if (target.split('/').includes('..') || realpathSync(currentLink) !== resolvedTarget) {
    throw new Error('Current link traverses or resolves through another symlink');
  }
  const current = releaseForPath(root, resolvedTarget);
  const device = lstatSync(root, { bigint: true }).dev;
  const releases = readdirSync(root)
    .sort()
    .map((id) => {
      releaseId.parse(id);
      const path = join(root, id);
      if (!lstatSync(path).isDirectory()) throw new Error('Release must be a real directory');
      return { id, ...inspectTree(path, device) };
    });
  // Existing deploy/rollback scripts do not participate in a common lock.
  // Never turn two equal observations into a serialization/healthy-deployment claim.
  return validateInventory({
    version: 1,
    root,
    current,
    observedAt: new Date().toISOString(),
    processes: observe(root),
    deploymentState: 'unknown',
    serializationReceipt: null,
    databaseStateFingerprint: null,
    releases,
  });
}

export function inspectReleaseInventory(root: string, observe: RuntimeObserver = observeSystemd) {
  const before = inspectOnce(root, observe);
  const after = inspectOnce(root, observe);
  if (inventoryDigest(before) !== inventoryDigest(after)) {
    throw new Error(
      'Inventory or runtime changed during inspection; deploy/rollback may be active',
    );
  }
  return after;
}
