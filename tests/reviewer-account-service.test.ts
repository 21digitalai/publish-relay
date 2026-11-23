import { describe, expect, it, vi } from 'vitest';

import {
  ReviewerAccountService,
  type ReviewerAccountStore,
} from '../src/modules/identity/reviewer-account.service.js';

function store(): ReviewerAccountStore {
  return {
    provision: vi.fn().mockResolvedValue({ userId: 'reviewer-user' }),
    revoke: vi.fn().mockResolvedValue({ userId: 'reviewer-user' }),
  };
}

describe('ReviewerAccountService', () => {
  it('generates a one-time password and provisions a bounded editor grant', async () => {
    const reviewerStore = store();
    const now = new Date('2026-11-23T12:00:00Z');
    const result = await new ReviewerAccountService(reviewerStore).provision({
      workspaceId: 'workspace',
      operatorUserId: 'owner',
      email: ' Reviewer@Example.Test ',
      now,
      requestId: 'request',
    });
    expect(result.password).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.expiresAt).toEqual(new Date('2026-12-23T12:00:00Z'));
    expect(reviewerStore.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace',
        operatorUserId: 'owner',
        email: 'reviewer@example.test',
        displayName: 'TikTok reviewer',
        expiresAt: result.expiresAt,
        requestId: 'request',
      }),
    );
    expect(result.password).not.toBe(
      vi.mocked(reviewerStore.provision).mock.calls[0]?.[0].passwordHash,
    );
  });

  it('rejects expiry beyond the bounded reviewer window before persistence', async () => {
    const reviewerStore = store();
    const service = new ReviewerAccountService(reviewerStore);
    await expect(
      service.provision({
        workspaceId: 'workspace',
        operatorUserId: 'owner',
        email: 'reviewer@example.test',
        now: new Date('2026-11-23T12:00:00Z'),
        expiresAt: new Date('2027-03-01T12:00:00Z'),
        requestId: 'request',
      }),
    ).rejects.toThrow('Reviewer expiry must be in the next 90 days');
    expect(reviewerStore.provision).not.toHaveBeenCalled();
  });

  it('normalizes reviewer identity before atomic revocation', async () => {
    const reviewerStore = store();
    await new ReviewerAccountService(reviewerStore).revoke({
      workspaceId: 'workspace',
      operatorUserId: 'owner',
      email: ' Reviewer@Example.Test ',
      requestId: 'request',
    });
    expect(reviewerStore.revoke).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      operatorUserId: 'owner',
      email: 'reviewer@example.test',
      requestId: 'request',
    });
  });
});
