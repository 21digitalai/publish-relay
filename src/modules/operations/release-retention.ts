import {
  evidenceSchema,
  inventoryDigest,
  INVENTORY_MAX_AGE_MS,
  ROLLBACK_COUNT,
  validateInventory,
} from './release-retention.contract.js';
import type { ReleaseInventory, RetentionEvidence } from './release-retention.contract.js';

function validateEvidence(inventory: ReleaseInventory, value: unknown): RetentionEvidence {
  const evidence = evidenceSchema.parse(value);
  const ids = new Set(inventory.releases.map((release) => release.id));
  for (const entries of [evidence.pins, evidence.compatibleRollbacks]) {
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new Error('Duplicate pin or compatibility record');
    }
    if (entries.some((entry) => !ids.has(entry.id))) {
      throw new Error('Unknown pin or rollback release');
    }
  }
  return evidence;
}

function findBlockers(input: {
  inventory: ReleaseInventory;
  fresh: ReleaseInventory;
  evidence: RetentionEvidence;
  now: number;
}): string[] {
  const { inventory, fresh, evidence, now } = input;
  const blockers: string[] = [];
  if (!Number.isFinite(now)) throw new Error('Invalid observation clock');
  if (
    inventoryDigest(inventory) !== inventoryDigest(fresh) ||
    evidence.inventoryDigest !== inventoryDigest(inventory)
  )
    blockers.push('stale-inventory');
  for (const snapshot of [inventory, fresh]) {
    const age = now - Date.parse(snapshot.observedAt);
    if (age < 0 || age > INVENTORY_MAX_AGE_MS) blockers.push('expired-inventory');
    if (snapshot.deploymentState !== 'idle') blockers.push('deployment-not-successfully-idle');
    if (!snapshot.databaseStateFingerprint) blockers.push('database-state-unverified');
    if (!snapshot.serializationReceipt) blockers.push('deployment-serialization-unverified');
    if (
      Object.values(snapshot.processes).some((process) => process.releaseId !== snapshot.current)
    ) {
      blockers.push('current-process-mismatch');
    }
  }
  if (Date.parse(fresh.observedAt) < Date.parse(inventory.observedAt))
    blockers.push('reversed-observation');
  if (!evidence.pinInventoryReceipt) blockers.push('pin-inventory-unverified');
  return [...new Set(blockers)];
}

function selectRollbacks(inventory: ReleaseInventory, evidence: RetentionEvidence, now: number) {
  return evidence.compatibleRollbacks
    .filter(
      (entry) =>
        entry.id !== inventory.current &&
        entry.againstCurrent === inventory.current &&
        entry.againstDatabaseStateFingerprint === inventory.databaseStateFingerprint &&
        Date.parse(entry.verifiedAt) <= now,
    )
    .sort((a, b) => Date.parse(b.verifiedAt) - Date.parse(a.verifiedAt) || a.id.localeCompare(b.id))
    .slice(0, ROLLBACK_COUNT)
    .map((entry) => entry.id);
}

export function retentionManifest(input: {
  inventory: unknown;
  freshInventory: unknown;
  evidence: unknown;
  now?: number;
}) {
  const inventory = validateInventory(input.inventory);
  const fresh = validateInventory(input.freshInventory);
  const evidence = validateEvidence(inventory, input.evidence);
  const now = input.now ?? Date.now();
  const blockers = findBlockers({ inventory, fresh, evidence, now });
  const rollbacks = selectRollbacks(inventory, evidence, now);
  if (rollbacks.length < ROLLBACK_COUNT)
    blockers.push('insufficient-verified-compatible-rollbacks');
  const protectedIds = new Set([
    inventory.current,
    ...rollbacks,
    ...Object.values(inventory.processes).map((process) => process.releaseId),
    ...evidence.pins.map((pin) => pin.id),
  ]);
  const releases = [...inventory.releases].sort((a, b) => a.id.localeCompare(b.id));
  const rows = releases.map((release) => ({
    path: `${inventory.root}/${release.id}`,
    allocatedBytes: release.allocatedBytes,
    reasons: [
      ...(release.id === inventory.current ? ['current'] : []),
      ...(Object.values(inventory.processes).some((process) => process.releaseId === release.id)
        ? ['running']
        : []),
      ...(rollbacks.includes(release.id) ? ['verified-compatible-rollback'] : []),
      ...evidence.pins.filter((pin) => pin.id === release.id).map((pin) => `pin:${pin.purpose}`),
      ...(blockers.length ? ['fail-closed'] : []),
    ],
    keep: blockers.length > 0 || protectedIds.has(release.id),
  }));
  const keep = rows
    .filter((row) => row.keep)
    .map((row) => ({ path: row.path, allocatedBytes: row.allocatedBytes, reasons: row.reasons }));
  const deleteCandidates = rows
    .filter((row) => !row.keep)
    .map((row) => ({ path: row.path, allocatedBytes: row.allocatedBytes, reasons: row.reasons }));
  return {
    version: 1,
    mode: 'dry-run-only',
    status: blockers.length ? 'blocked' : 'proposal-only',
    policy: {
      current: inventory.current,
      rollbackCount: ROLLBACK_COUNT,
      unlimitedExplicitPins: true,
    },
    inventoryDigest: inventoryDigest(inventory),
    blockers: blockers.sort(),
    selectedRollbackIds: rollbacks,
    keep,
    deleteCandidates,
    approvedDeletePaths: [],
    allocatedBytes: {
      keep: keep.reduce((sum, row) => sum + row.allocatedBytes, 0),
      deleteCandidates: deleteCandidates.reduce((sum, row) => sum + row.allocatedBytes, 0),
      approvedDelete: 0,
    },
  };
}
