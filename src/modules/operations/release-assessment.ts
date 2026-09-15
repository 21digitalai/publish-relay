import { posix } from 'node:path';
import { z } from 'zod';
import { releaseId, ROLLBACK_COUNT, validateRoot } from './release-retention.contract.js';

const assessmentSchema = z.object({
  approvedDeletePaths: z.array(z.string()).length(0),
  releases: z
    .array(
      z.object({
        path: z.string(),
        allocatedBytes: z.number().int().nonnegative(),
        authorizedAction: z.literal('keep'),
      }),
    )
    .min(1),
});

// Legacy assessment inventories have no freshness, process, pin, or compatibility proof.
// Accept them only into this one-way, keep-everything report, never the policy proposal path.
export function assessmentManifest(value: unknown) {
  const assessment = assessmentSchema.parse(value);
  const roots = new Set(assessment.releases.map((release) => posix.dirname(release.path)));
  if (roots.size !== 1) throw new Error('Assessment must have exactly one release root');
  const root = [...roots][0];
  if (!root) throw new Error('Missing release root');
  validateRoot(root);
  const paths = new Set<string>();
  for (const release of assessment.releases) {
    releaseId.parse(posix.basename(release.path));
    if (release.path !== `${root}/${posix.basename(release.path)}` || paths.has(release.path)) {
      throw new Error('Malformed or duplicate assessment path');
    }
    paths.add(release.path);
  }
  const keep = [...assessment.releases]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((release) => ({
      path: release.path,
      allocatedBytes: release.allocatedBytes,
      reasons: ['unverified-historical-assessment'],
    }));
  const total = keep.reduce((sum, release) => sum + release.allocatedBytes, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Allocated-byte total overflow');
  return {
    version: 1,
    mode: 'dry-run-only',
    status: 'blocked',
    policy: { rollbackCount: ROLLBACK_COUNT, unlimitedExplicitPins: true },
    blockers: [
      'historical-inventory-not-live-verified',
      'pin-inventory-unverified',
      'deployment-serialization-unverified',
      'database-state-unverified',
      'insufficient-verified-compatible-rollbacks',
    ],
    keep,
    deleteCandidates: [],
    approvedDeletePaths: [],
    allocatedBytes: { keep: total, deleteCandidates: 0, approvedDelete: 0 },
  };
}
