import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessmentManifest } from '../src/modules/operations/release-assessment.js';
import { inspectReleaseInventory } from '../src/modules/operations/release-inventory.js';
import {
  inventoryDigest,
  validateInventory,
} from '../src/modules/operations/release-retention.contract.js';
import type {
  ReleaseInventory,
  RetentionEvidence,
} from '../src/modules/operations/release-retention.contract.js';
import { retentionManifest } from '../src/modules/operations/release-retention.js';

const NOW = Date.parse('2030-01-01T00:00:00Z');
const DATABASE = 'd'.repeat(64);
const ids = [
  'abcdef1-r1',
  'abcdef2-r1',
  'abcdef3-r1',
  'abcdef4-r1',
  'abcdef5-r1',
  'abcdef6-r1',
  'abcdef7-r1',
  'abcdef8-r1',
] as const;
const current = ids[0];
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'relay-retention-')));
  temporary.push(parent);
  const root = join(parent, 'releases');
  mkdirSync(root);
  for (const id of ids) {
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, 'artifact'), `immutable-${id}`);
  }
  symlinkSync(join(root, current), join(parent, 'current'));
  // Protected siblings deliberately contain data but must never enter the inventory.
  for (const name of ['media', 'backups', 'database', 'node24']) {
    mkdirSync(join(parent, name));
    writeFileSync(join(parent, name, 'protected'), 'never delete');
  }
  const processes = {
    web: { pid: 100, startTime: '1234', releaseId: current },
    worker: { pid: 101, startTime: '1235', releaseId: current },
  };
  const observed = inspectReleaseInventory(root, () => processes);
  const inventory: ReleaseInventory = {
    ...observed,
    observedAt: new Date(NOW - 1000).toISOString(),
    deploymentState: 'idle',
    serializationReceipt: 'synthetic fixture lock receipt',
    databaseStateFingerprint: DATABASE,
  };
  const evidence: RetentionEvidence = {
    version: 1,
    inventoryDigest: inventoryDigest(inventory),
    pinInventoryReceipt: 'synthetic complete pin review',
    pins: [],
    compatibleRollbacks: ids.slice(1, 4).map((id, index) => ({
      id,
      againstCurrent: current,
      againstDatabaseStateFingerprint: DATABASE,
      databaseCompatibility: 'verified',
      successfulDeployment: true,
      verifiedAt: new Date(NOW - (index + 1) * 1000).toISOString(),
      receipt: 'synthetic rollback + database compatibility drill',
    })),
  };
  return { parent, root, processes, inventory, evidence };
}

function plan(value: ReturnType<typeof fixture>, fresh = value.inventory) {
  return retentionManifest({
    inventory: value.inventory,
    evidence: value.evidence,
    freshInventory: fresh,
    now: NOW,
  });
}

describe('read-only release retention policy', () => {
  it('keeps active-oldest plus exactly three verified rollbacks, with exact allocated totals', () => {
    const value = fixture();
    const result = plan(value);
    expect(result.status).toBe('proposal-only');
    expect(result.keep.map((row) => row.path)).toEqual(
      ids.slice(0, 4).map((id) => join(value.root, id)),
    );
    expect(result.deleteCandidates.map((row) => row.path)).toEqual(
      ids.slice(4).map((id) => join(value.root, id)),
    );
    expect(result.allocatedBytes.keep + result.allocatedBytes.deleteCandidates).toBe(
      value.inventory.releases.reduce((sum, release) => sum + release.allocatedBytes, 0),
    );
    expect(result.approvedDeletePaths).toEqual([]);
    expect(result.allocatedBytes.approvedDelete).toBe(0);
  });

  it('preserves unlimited explicit migration and recovery pins beyond rollback count', () => {
    const value = fixture();
    value.evidence.pins = ids.slice(4).map((id, index) => ({
      id,
      purpose: index % 2 ? 'recovery' : 'migration',
      receipt: 'fixture owner pin',
    }));
    expect(plan(value).keep).toHaveLength(8);
    expect(plan(value).deleteCandidates).toEqual([]);
  });

  it('does not count migration equality, an unverified candidate, or a pin as rollback proof', () => {
    const value = fixture();
    value.evidence.compatibleRollbacks.pop();
    value.evidence.pins = [{ id: ids[3], purpose: 'migration', receipt: 'precaution only' }];
    const result = plan(value);
    expect(result.blockers).toContain('insufficient-verified-compatible-rollbacks');
    expect(result.keep).toHaveLength(8);
    expect(result.deleteCandidates).toEqual([]);
  });

  it('binds verified rollback proof to the current release and exact database state', () => {
    const value = fixture();
    required(value.evidence.compatibleRollbacks[0]).againstDatabaseStateFingerprint = 'e'.repeat(
      64,
    );
    required(value.evidence.compatibleRollbacks[1]).againstCurrent = ids[7];
    expect(plan(value).selectedRollbackIds).toEqual([ids[3]]);
    expect(plan(value).deleteCandidates).toEqual([]);
  });

  it.each(['busy', 'failed', 'unknown'] as const)('refuses %s deployment state', (state) => {
    const value = fixture();
    value.inventory.deploymentState = state;
    value.evidence.inventoryDigest = inventoryDigest(value.inventory);
    expect(plan(value).blockers).toContain('deployment-not-successfully-idle');
    expect(plan(value).keep).toHaveLength(8);
  });

  it('refuses unverified serialization, database state and pin inventory', () => {
    const value = fixture();
    value.inventory.serializationReceipt = null;
    value.inventory.databaseStateFingerprint = null;
    value.evidence.pinInventoryReceipt = null;
    expect(plan(value).blockers).toEqual(
      expect.arrayContaining([
        'deployment-serialization-unverified',
        'database-state-unverified',
        'pin-inventory-unverified',
      ]),
    );
    expect(plan(value).deleteCandidates).toEqual([]);
  });

  it('refuses unknown pins, unknown rollbacks and duplicate evidence', () => {
    const value = fixture();
    value.evidence.pins = [{ id: 'aaaaaaa-r1', purpose: 'recovery', receipt: 'fixture' }];
    expect(() => plan(value)).toThrow('Unknown');
    value.evidence.pins = [];
    value.evidence.compatibleRollbacks.push({ ...required(value.evidence.compatibleRollbacks[0]) });
    expect(() => plan(value)).toThrow('Duplicate');
    value.evidence.compatibleRollbacks.pop();
    required(value.evidence.compatibleRollbacks[0]).id = 'aaaaaaa-r1';
    expect(() => plan(value)).toThrow('Unknown');
  });

  it('refuses stale plan digest and changed file, current or process identity', () => {
    const value = fixture();
    value.evidence.inventoryDigest = '0'.repeat(64);
    expect(plan(value).blockers).toContain('stale-inventory');
    value.evidence.inventoryDigest = inventoryDigest(value.inventory);
    const mutations = [
      (fresh: ReleaseInventory) => {
        required(fresh.releases[0]).fingerprint = '1'.repeat(64);
      },
      (fresh: ReleaseInventory) => {
        fresh.current = ids[7];
      },
      (fresh: ReleaseInventory) => {
        fresh.processes.web.startTime = '9999';
      },
      (fresh: ReleaseInventory) => {
        required(fresh.releases[7]).allocatedBytes += 512;
      },
    ];
    for (const mutate of mutations) {
      const fresh = structuredClone(value.inventory);
      mutate(fresh);
      expect(plan(value, fresh).blockers).toContain('stale-inventory');
      expect(plan(value, fresh).deleteCandidates).toEqual([]);
    }
  });

  it('keeps every running release when processes disagree with current', () => {
    const value = fixture();
    value.inventory.processes.worker.releaseId = ids[7];
    value.evidence.inventoryDigest = inventoryDigest(value.inventory);
    const result = plan(value);
    expect(result.blockers).toContain('current-process-mismatch');
    expect(required(result.keep.find((row) => row.path.endsWith(ids[7]))).reasons).toContain(
      'running',
    );
  });

  it('rejects old, future, and reversed observations', () => {
    const value = fixture();
    value.inventory.observedAt = new Date(NOW - 300001).toISOString();
    expect(plan(value).blockers).toContain('expired-inventory');
    value.inventory.observedAt = new Date(NOW + 1).toISOString();
    expect(plan(value).blockers).toContain('expired-inventory');
    value.inventory.observedAt = new Date(NOW - 1000).toISOString();
    const fresh = { ...value.inventory, observedAt: new Date(NOW - 2000).toISOString() };
    expect(plan(value, fresh).blockers).toContain('reversed-observation');
  });

  it('is deterministic, order-independent, and leaves the filesystem immutable', () => {
    const value = fixture();
    const before = inspectReleaseInventory(value.root, () => value.processes);
    const result = JSON.stringify(plan(value));
    value.inventory.releases.reverse();
    value.evidence.compatibleRollbacks.reverse();
    expect(JSON.stringify(plan(value))).toBe(result);
    expect(inventoryDigest(inspectReleaseInventory(value.root, () => value.processes))).toBe(
      inventoryDigest(before),
    );
  });
});

describe('filesystem inventory refuses unsafe observations', () => {
  it('measures allocated blocks without claiming database, lock, or deployment proof', () => {
    const value = fixture();
    const inventory = inspectReleaseInventory(value.root, () => value.processes);
    expect(inventory.releases).toHaveLength(8);
    expect(inventory.releases.every((release) => release.allocatedBytes > 0)).toBe(true);
    expect(inventory.serializationReceipt).toBeNull();
    expect(inventory.databaseStateFingerprint).toBeNull();
    expect(inventory.deploymentState).toBe('unknown');
  });

  it.each(['../releases', '.', '..', 'media', 'backups', 'database', 'node24'])(
    'refuses malformed/protected root %s',
    (suffix) => {
      const value = fixture();
      expect(() =>
        inspectReleaseInventory(join(value.parent, suffix), () => value.processes),
      ).toThrow();
    },
  );

  it('refuses lexical traversal and protected data subtrees even in submitted snapshots', () => {
    const value = fixture();
    for (const root of [
      value.root + '/../releases',
      '/var/lib/publish-relay/releases',
      '/srv/backups/releases',
      '/srv/media/releases',
      '/releases',
      'relative/releases',
    ]) {
      expect(() => validateInventory({ ...value.inventory, root })).toThrow();
    }
  });

  it.each(['root', 'release', 'nested', 'current'])('refuses escaping %s symlinks', (kind) => {
    const value = fixture();
    if (kind === 'root') {
      const alias = join(value.parent, 'alias');
      symlinkSync(value.parent, alias);
      expect(() =>
        inspectReleaseInventory(join(alias, 'releases'), () => value.processes),
      ).toThrow();
      return;
    }
    const target =
      kind === 'release'
        ? join(value.root, ids[7])
        : kind === 'nested'
          ? join(value.root, current, 'escape')
          : join(value.parent, 'current');
    rmSync(target, { recursive: true, force: true });
    symlinkSync(join(value.parent, 'backups'), target);
    expect(() => inspectReleaseInventory(value.root, () => value.processes)).toThrow();
  });

  it('refuses even contained release symlinks and shared hard-linked bytes', () => {
    const value = fixture();
    const target = join(value.root, current, 'linked');
    symlinkSync(join(value.root, current, 'artifact'), target);
    expect(() => inspectReleaseInventory(value.root, () => value.processes)).toThrow('Symlinks');
    rmSync(target);
    linkSync(join(value.root, current, 'artifact'), target);
    expect(() => inspectReleaseInventory(value.root, () => value.processes)).toThrow('hard-linked');
  });

  it('refuses missing current, malformed release names and absent processes', () => {
    const value = fixture();
    mkdirSync(join(value.root, 'not-a-release'));
    expect(() => inspectReleaseInventory(value.root, () => value.processes)).toThrow();
    rmSync(join(value.root, 'not-a-release'), { recursive: true });
    expect(() =>
      inspectReleaseInventory(value.root, () => {
        throw new Error('service stopped');
      }),
    ).toThrow();
    rmSync(join(value.parent, 'current'));
    expect(() => inspectReleaseInventory(value.root, () => value.processes)).toThrow();
  });

  it('refuses an inventory mutation or concurrent rollback between observations', () => {
    const value = fixture();
    let calls = 0;
    expect(() =>
      inspectReleaseInventory(value.root, () => {
        if (++calls === 1) writeFileSync(join(value.root, current, 'artifact'), 'changed');
        return value.processes;
      }),
    ).toThrow('changed during inspection');
    calls = 0;
    expect(() =>
      inspectReleaseInventory(value.root, () => {
        if (++calls === 1) {
          rmSync(join(value.parent, 'current'));
          symlinkSync(join(value.root, ids[7]), join(value.parent, 'current'));
        }
        return value.processes;
      }),
    ).toThrow('changed during inspection');
  });
});

describe('historical assessment CLI', () => {
  it('emits all exact paths/bytes as keep, ignores speculative candidate labels, and never applies', () => {
    const value = fixture();
    const assessment = {
      approvedDeletePaths: [],
      releases: value.inventory.releases.map((release) => ({
        path: join(value.root, release.id),
        allocatedBytes: release.allocatedBytes,
        proposal: 'conditional-delete-candidate',
        authorizedAction: 'keep',
      })),
    };
    const path = join(value.parent, 'assessment.json');
    writeFileSync(path, JSON.stringify(assessment));
    const cli = join(import.meta.dirname, '../src/entrypoints/release-retention.ts');
    const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'assessment', path], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual(assessmentManifest(assessment));
    expect(assessmentManifest(assessment).keep).toHaveLength(8);
    expect(assessmentManifest(assessment).approvedDeletePaths).toEqual([]);
    const apply = spawnSync(process.execPath, ['--import', 'tsx', cli, 'apply', path], {
      encoding: 'utf8',
    });
    expect(apply.status).toBe(1);
    expect(apply.stdout).toBe('');
    expect(inspectReleaseInventory(value.root, () => value.processes).releases).toHaveLength(8);
    expect(() =>
      assessmentManifest({
        ...assessment,
        approvedDeletePaths: [required(assessment.releases[0]).path],
      }),
    ).toThrow();
  });
});
