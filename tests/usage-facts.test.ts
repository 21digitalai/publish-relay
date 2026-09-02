import { describe, expect, it, vi } from 'vitest';

import { getWorkspaceUsageFacts } from '../src/modules/policy/usage-facts.js';

describe('workspace usage facts', () => {
  it('maps one transactional tenant-scoped snapshot and deduplicates requested targets', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{
        retained_bytes: '300', temporary_media: '1', ready_media: '2', deleted_media: '3',
        connected_accounts: '4', provider_families: '2', existing_targets: '3', active_targets: '5',
        furthest_scheduled_at: new Date('2026-09-03T00:00:00Z'), workspace_members: '6',
      }],
    });
    const transaction = vi.fn(async (operation: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      operation({ execute }),
    );
    const facts = await getWorkspaceUsageFacts(
      { transaction } as never,
      { workspaceId: 'workspace-a', requestedProviderAccountIds: ['account-a', 'account-a', 'account-b'] },
    );

    expect(facts).toMatchObject({
      media: { retainedBytes: 300, countsByState: { temporary: 1, ready: 2, deleted: 3 } },
      connectedProviderAccounts: 4,
      distinctProviderFamilies: 2,
      existingPublicationTargets: 3,
      requestedPublicationTargets: 2,
      queuedOrScheduledTargets: 5,
      workspaceMembers: 6,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('keeps concurrent workspace snapshots in independent transactions', async () => {
    const rows = [
      { retained_bytes: '10', temporary_media: '1', ready_media: '0', deleted_media: '0', connected_accounts: '1', provider_families: '1', existing_targets: '1', active_targets: '1', furthest_scheduled_at: null, workspace_members: '1' },
      { retained_bytes: '20', temporary_media: '0', ready_media: '1', deleted_media: '1', connected_accounts: '2', provider_families: '1', existing_targets: '2', active_targets: '0', furthest_scheduled_at: null, workspace_members: '2' },
    ];
    let transactionIndex = 0;
    const transaction = vi.fn(async (operation: (tx: { execute: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const row = rows[transactionIndex++];
      const execute = vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [row] });
      return operation({ execute });
    });

    const [first, second] = await Promise.all([
      getWorkspaceUsageFacts({ transaction } as never, { workspaceId: 'workspace-a' }),
      getWorkspaceUsageFacts({ transaction } as never, { workspaceId: 'workspace-b' }),
    ]);

    expect(first.media.retainedBytes).toBe(10);
    expect(second.media.retainedBytes).toBe(20);
    expect(first.connectedProviderAccounts).toBe(1);
    expect(second.connectedProviderAccounts).toBe(2);
  });
});
