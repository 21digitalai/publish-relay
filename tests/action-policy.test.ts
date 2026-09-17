import { describe, expect, it, vi } from 'vitest';

import {
  ActionPolicyDeniedError,
  allowAllActionPolicy,
  enforceActionPolicy,
  type ActionPolicyContext,
} from '../src/modules/policy/action-policy.js';

const context = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  actor: { type: 'user' as const, id: '00000000-0000-4000-8000-000000000002' },
  action: 'publication.create' as const,
  facts: {
    media: { retainedBytes: 0, countsByState: { temporary: 0, ready: 0, deleted: 0 } },
    connectedProviderAccounts: 0,
    distinctProviderFamilies: 0,
    existingPublicationTargets: 0,
    requestedPublicationTargets: 0,
    queuedOrScheduledTargets: 0,
    furthestScheduledAt: null,
    workspaceMembers: 1,
  },
  request: {},
  transaction: {} as ActionPolicyContext['transaction'],
};

describe('action policy contract', () => {
  it('allows standalone Core actions without commercial behavior', async () => {
    await expect(enforceActionPolicy(allowAllActionPolicy, context)).resolves.toBeUndefined();
  });

  it('preserves a stable neutral denial code and safe metadata', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      allowed: false,
      code: 'action_not_allowed',
      reason: 'This action is not available',
      metadata: { retryable: false },
    });
    await expect(enforceActionPolicy({ evaluate }, context)).rejects.toMatchObject({
      name: ActionPolicyDeniedError.name,
      code: 'action_not_allowed',
      metadata: { retryable: false },
    });
    expect(evaluate).toHaveBeenCalledOnce();
  });
});
