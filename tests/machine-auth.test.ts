import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { DelegatedAuthorizationService } from '../src/modules/delegated-authorization/delegated-authorization.service.js';
import type { ApiKeyService } from '../src/modules/identity/api-key.service.js';
import {
  authorizeMachineRequest,
  MachineAuthorizationError,
} from '../src/modules/identity/machine-auth.js';

function applicationWithHandler(
  apiKeys: ApiKeyService,
  delegatedAuthorization?: DelegatedAuthorizationService,
) {
  const application = Fastify();
  application.get('/', async (request, reply) => {
    try {
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'destinations:read',
      );
      return principal ?? (await reply.code(401).send({ error: 'unauthorized' }));
    } catch (error) {
      if (error instanceof MachineAuthorizationError)
        return reply.code(403).send({ error: error.code });
      throw error;
    }
  });
  return application;
}

describe('machine authentication boundary', () => {
  it('preserves API-key authentication and capability enforcement', async () => {
    const principal = {
      id: 'key-1',
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      workspaceLabel: 'Atlas',
      prefix: 'pr_key',
      capabilities: ['destinations:read'],
      expiresAt: null,
    };
    const requireCapability = vi.fn().mockResolvedValue(undefined);
    const apiKeys = {
      authenticate: vi.fn().mockResolvedValue(principal),
      requireCapability,
    } as unknown as ApiKeyService;
    const response = await applicationWithHandler(apiKeys).inject({
      method: 'GET',
      url: '/',
      headers: {
        authorization: 'Bearer api-token',
        'x-publish-relay-workspace': 'workspace-1',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'api-key', actorId: 'key-1' });
    expect(requireCapability).toHaveBeenCalledWith(
      principal,
      'destinations:read',
      expect.any(String),
    );
  });

  it('accepts a delegated grant only for its expected workspace and scope', async () => {
    const apiKeys = {
      authenticate: vi.fn().mockResolvedValue(null),
    } as unknown as ApiKeyService;
    const delegatedAuthorization = {
      authenticate: vi.fn().mockResolvedValue({
        grantId: 'grant-1',
        workspaceId: 'workspace-1',
        userId: 'user-1',
        clientId: 'client-1',
        scopes: ['destinations:read'],
      }),
    } as unknown as DelegatedAuthorizationService;
    const response = await applicationWithHandler(apiKeys, delegatedAuthorization).inject({
      method: 'GET',
      url: '/',
      headers: {
        authorization: 'Bearer delegated-token',
        'x-publish-relay-workspace': 'workspace-1',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: 'delegated',
      actorId: 'grant-1',
      clientId: 'client-1',
    });
  });

  it('rejects delegated credentials outside the expected workspace or capability', async () => {
    const apiKeys = { authenticate: vi.fn().mockResolvedValue(null) } as unknown as ApiKeyService;
    const authenticate = vi.fn().mockResolvedValue({
      grantId: 'grant-1',
      workspaceId: 'workspace-2',
      userId: 'user-1',
      clientId: 'client-1',
      scopes: [],
    });
    const delegatedAuthorization = { authenticate } as unknown as DelegatedAuthorizationService;
    const wrongWorkspace = await applicationWithHandler(apiKeys, delegatedAuthorization).inject({
      method: 'GET',
      url: '/',
      headers: {
        authorization: 'Bearer delegated-token',
        'x-publish-relay-workspace': 'workspace-1',
      },
    });
    expect(wrongWorkspace.statusCode).toBe(401);

    authenticate.mockResolvedValue({
      grantId: 'grant-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      clientId: 'client-1',
      scopes: [],
    });
    const missingScope = await applicationWithHandler(apiKeys, delegatedAuthorization).inject({
      method: 'GET',
      url: '/',
      headers: {
        authorization: 'Bearer delegated-token',
        'x-publish-relay-workspace': 'workspace-1',
      },
    });
    expect(missingScope.statusCode).toBe(403);
  });
});
