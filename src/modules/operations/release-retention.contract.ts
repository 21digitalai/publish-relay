import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';

export const ROLLBACK_COUNT = 0;
export const INVENTORY_MAX_AGE_MS = 5 * 60 * 1000;
export const releaseId = z.string().regex(/^[a-f0-9]{7,40}-r[1-9][0-9]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z.string().trim().min(1).max(1000);
const processReference = z
  .object({
    pid: z.number().int().positive(),
    startTime: z.string().regex(/^[0-9]+$/),
    releaseId,
  })
  .strict();

export const inventorySchema = z
  .object({
    version: z.literal(1),
    root: z.string(),
    observedAt: z.iso.datetime(),
    current: releaseId,
    processes: z.object({ web: processReference, worker: processReference }).strict(),
    deploymentState: z.enum(['idle', 'busy', 'failed', 'unknown']),
    serializationReceipt: receipt.nullable(),
    databaseStateFingerprint: digest.nullable(),
    releases: z
      .array(
        z
          .object({
            id: releaseId,
            allocatedBytes: z.number().int().nonnegative(),
            fingerprint: digest,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const evidenceSchema = z
  .object({
    version: z.literal(1),
    inventoryDigest: digest,
    pinInventoryReceipt: receipt.nullable(),
    pins: z.array(
      z
        .object({
          id: releaseId,
          purpose: z.enum(['migration', 'recovery']),
          receipt,
        })
        .strict(),
    ),
    compatibleRollbacks: z.array(
      z
        .object({
          id: releaseId,
          againstCurrent: releaseId,
          againstDatabaseStateFingerprint: digest,
          databaseCompatibility: z.literal('verified'),
          successfulDeployment: z.literal(true),
          verifiedAt: z.iso.datetime(),
          receipt,
        })
        .strict(),
    ),
  })
  .strict();

export type ReleaseInventory = z.infer<typeof inventorySchema>;
export type RetentionEvidence = z.infer<typeof evidenceSchema>;

export function validateRoot(root: string): void {
  if (
    !posix.isAbsolute(root) ||
    posix.normalize(root) !== root ||
    posix.basename(root) !== 'releases' ||
    posix.dirname(root) === '/' ||
    root.startsWith('/var/lib/') ||
    root.startsWith('/etc/') ||
    root
      .split('/')
      .some((part) =>
        ['media', 'backups', 'database', 'databases', 'node24', 'node_modules'].includes(part),
      ) ||
    root.includes('\\') ||
    Array.from(root).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error('Expected a canonical absolute application/releases root');
  }
}

export function validateInventory(value: unknown): ReleaseInventory {
  const inventory = inventorySchema.parse(value);
  validateRoot(inventory.root);
  const ids = inventory.releases.map((release) => release.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate release');
  for (const id of [
    inventory.current,
    inventory.processes.web.releaseId,
    inventory.processes.worker.releaseId,
  ]) {
    if (!ids.includes(id)) throw new Error('Missing current or running release');
  }
  const total = inventory.releases.reduce((sum, release) => sum + release.allocatedBytes, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Allocated-byte total overflow');
  return inventory;
}

export function inventoryDigest(inventory: ReleaseInventory): string {
  // Observation time changes on a repeat scan; identity and allocated bytes must not.
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: inventory.version,
        root: inventory.root,
        current: inventory.current,
        processes: inventory.processes,
        deploymentState: inventory.deploymentState,
        serializationReceipt: inventory.serializationReceipt,
        databaseStateFingerprint: inventory.databaseStateFingerprint,
        releases: [...inventory.releases].sort((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest('hex');
}
