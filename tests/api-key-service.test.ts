import { describe, expect, it, vi } from 'vitest';

import { hashApiKeySecret } from '../src/modules/identity/api-key.js';
import {
  ApiKeyService,
  type ApiKeyPrincipal,
  type ApiKeyStore,
} from '../src/modules/identity/api-key.service.js';

function createHarness() {
  const create = vi.fn<ApiKeyStore['create']>();
  const findByPrefix = vi.fn<ApiKeyStore['findByPrefix']>();
  const list = vi.fn<ApiKeyStore['list']>();
  const markUsed = vi.fn<ApiKeyStore['markUsed']>();
  const recordCapabilityDenied = vi.fn<ApiKeyStore['recordCapabilityDenied']>();
  const revoke = vi.fn<ApiKeyStore['revoke']>();
  return {
    store: { create, findByPrefix, list, markUsed, recordCapabilityDenied, revoke },
    create,
    findByPrefix,
    list,
    markUsed,
    recordCapabilityDenied,
    revoke,
  };
}

describe('API key service', () => {
  it('reveals new key material once and persists only its hash', async () => {
    const { store, create } = createHarness();
    create.mockImplementation((input) =>
      Promise.resolve({
        id: 'key-1',
        workspaceId: input.workspaceId,
        createdByUserId: input.createdByUserId,
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
      requestId: 'request-1',
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
      createdByUserId: 'user-1',
      workspaceLabel: 'Atlas',
      prefix: 'pr_public',
      secretHash: hashApiKeySecret('secret'),
      capabilities: ['audit:read'],
      expiresAt: null,
      revokedAt: null,
    });
    const now = new Date('2026-08-31T18:00:00Z');
    const principal = await new ApiKeyService(store).authenticate(
      'workspace-1',
      'pr_public.secret',
      now,
    );
    expect(principal).toEqual({
      id: 'key-1',
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
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
      createdByUserId: 'user-1',
      workspaceLabel: 'Atlas',
      prefix: 'pr_public',
      secretHash: hashApiKeySecret('secret'),
      capabilities: [],
      expiresAt: null,
      revokedAt: new Date(),
    });
    const service = new ApiKeyService(store);
    expect(await service.authenticate('workspace-1', 'invalid')).toBeNull();
    expect(await service.authenticate('workspace-1', 'pr_public.wrong')).toBeNull();
    expect(findByPrefix).toHaveBeenCalledWith('workspace-1', 'pr_public');
    expect(markUsed).not.toHaveBeenCalled();
  });

  it('rejects an expired credential without updating usage', async () => {
    const { store, findByPrefix, markUsed } = createHarness();
    findByPrefix.mockResolvedValue({
      id: 'key-1',
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      workspaceLabel: 'Atlas',
      prefix: 'pr_public',
      secretHash: hashApiKeySecret('secret'),
      capabilities: [],
      expiresAt: new Date('2026-08-31T17:00:00Z'),
      revokedAt: null,
    });
    const service = new ApiKeyService(store);
    await expect(
      service.authenticate('workspace-1', 'pr_public.secret', new Date('2026-08-31T18:00:00Z')),
    ).resolves.toBeNull();
    expect(markUsed).not.toHaveBeenCalled();
  });

  it('audits a centralized capability denial without secret material', async () => {
    const { store, recordCapabilityDenied } = createHarness();
    const principal: ApiKeyPrincipal = {
      id: 'key-1',
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      workspaceLabel: 'Atlas',
      prefix: 'pr_public',
      capabilities: ['schedules:read'],
      expiresAt: null,
    };
    await expect(
      new ApiKeyService(store).requireCapability(principal, 'schedules:write', 'request-1'),
    ).rejects.toMatchObject({ statusCode: 403, code: 'missing_capability' });
    expect(recordCapabilityDenied).toHaveBeenCalledWith(principal, 'schedules:write', 'request-1');
    expect(JSON.stringify(recordCapabilityDenied.mock.calls)).not.toContain('secret');
  });

  it('revokes a workspace-scoped key immediately through the store', async () => {
    const { store, revoke } = createHarness();
    revoke.mockResolvedValue(true);
    const revokedAt = new Date('2026-08-31T18:00:00Z');
    await expect(
      new ApiKeyService(store).revoke({
        workspaceId: 'workspace-1',
        keyId: 'key-1',
        revokedByUserId: 'user-1',
        requestId: 'request-2',
        revokedAt,
      }),
    ).resolves.toBe(true);
    expect(revoke).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      keyId: 'key-1',
      revokedByUserId: 'user-1',
      requestId: 'request-2',
      revokedAt,
    });
  });
});
