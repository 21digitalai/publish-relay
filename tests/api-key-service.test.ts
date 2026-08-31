import { describe, expect, it, vi } from 'vitest';

import { hashApiKeySecret } from '../src/modules/identity/api-key.js';
import { ApiKeyService, type ApiKeyStore } from '../src/modules/identity/api-key.service.js';

function createHarness() {
  const create = vi.fn<ApiKeyStore['create']>();
  const findByPrefix = vi.fn<ApiKeyStore['findByPrefix']>();
  const markUsed = vi.fn<ApiKeyStore['markUsed']>();
  return { store: { create, findByPrefix, markUsed }, create, findByPrefix, markUsed };
}

describe('API key service', () => {
  it('reveals new key material once and persists only its hash', async () => {
    const { store, create } = createHarness();
    create.mockImplementation((input) =>
      Promise.resolve({
        id: 'key-1',
        workspaceId: input.workspaceId,
        workspaceLabel: 'Atlas',
        prefix: input.prefix,
        capabilities: input.capabilities,
        expiresAt: input.expiresAt,
      }),
    );
    const result = await new ApiKeyService(store).create({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      label: 'Automation',
      capabilities: ['schedules:read'],
    });
    expect(result.token).toMatch(/^pr_[0-9a-f]{12}\./);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: ['schedules:read'] }),
    );
    expect(JSON.stringify(create.mock.calls)).not.toContain(result.token);
  });

  it('authenticates an active key, updates usage, and returns no secret fields', async () => {
    const { store, findByPrefix, markUsed } = createHarness();
    findByPrefix.mockResolvedValue({
      id: 'key-1',
      workspaceId: 'workspace-1',
      workspaceLabel: 'Atlas',
      prefix: 'pr_public',
      secretHash: hashApiKeySecret('secret'),
      capabilities: ['audit:read'],
      expiresAt: null,
      revokedAt: null,
    });
    const now = new Date('2026-08-31T18:00:00Z');
    const principal = await new ApiKeyService(store).authenticate('pr_public.secret', now);
    expect(principal).toEqual({
      id: 'key-1',
      workspaceId: 'workspace-1',
      workspaceLabel: 'Atlas',
      prefix: 'pr_public',
      capabilities: ['audit:read'],
      expiresAt: null,
    });
    expect(markUsed).toHaveBeenCalledWith('workspace-1', 'key-1', now);
  });

  it('rejects invalid and revoked credentials without updating usage', async () => {
    const { store, findByPrefix, markUsed } = createHarness();
    findByPrefix.mockResolvedValue({
      id: 'key-1',
      workspaceId: 'workspace-1',
      workspaceLabel: 'Atlas',
      prefix: 'pr_public',
      secretHash: hashApiKeySecret('secret'),
      capabilities: [],
      expiresAt: null,
      revokedAt: new Date(),
    });
    const service = new ApiKeyService(store);
    expect(await service.authenticate('invalid')).toBeNull();
    expect(await service.authenticate('pr_public.wrong')).toBeNull();
    expect(markUsed).not.toHaveBeenCalled();
  });
});
