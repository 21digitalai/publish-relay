import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import type { ApiKeyCapability } from './api-key.js';
import type { ApiKeyPrincipal, ApiKeyService } from './api-key.service.js';

export type MachinePrincipal =
  | ({ kind: 'api-key'; actorId: string } & ApiKeyPrincipal)
  | {
      kind: 'delegated';
      actorId: string;
      workspaceId: string;
      workspaceLabel: string;
      userId: string;
      clientId: string;
      capabilities: ApiKeyCapability[];
      accessExpiresAt: Date;
    };

export class MachineAuthorizationError extends Error {
  public readonly statusCode = 403;
  public readonly code = 'missing_capability';
}

function readBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return null;
  return authorization.slice('Bearer '.length).trim() || null;
}

export async function authorizeMachineRequest(
  request: FastifyRequest,
  apiKeys: ApiKeyService,
  delegatedAuthorization?: DelegatedAuthorizationService,
  requiredCapability?: ApiKeyCapability,
): Promise<MachinePrincipal | null> {
  const expectedWorkspaceId = request.headers['x-publish-relay-workspace'];
  const token = readBearerToken(request);
  if (
    typeof expectedWorkspaceId !== 'string' ||
    !z.uuid().safeParse(expectedWorkspaceId).success ||
    !token
  )
    return null;

  const apiKey = await apiKeys.authenticate(expectedWorkspaceId, token);
  if (apiKey) {
    if (requiredCapability) await apiKeys.requireCapability(apiKey, requiredCapability, request.id);
    return { ...apiKey, kind: 'api-key', actorId: apiKey.id };
  }

  const delegated = await delegatedAuthorization?.authenticate(token);
  if (delegated?.workspaceId !== expectedWorkspaceId) return null;
  if (requiredCapability && !delegated.scopes.includes(requiredCapability))
    throw new MachineAuthorizationError(
      `Delegated credential is missing capability ${requiredCapability}`,
    );
  return {
    kind: 'delegated',
    actorId: delegated.grantId,
    workspaceId: delegated.workspaceId,
    workspaceLabel: delegated.workspaceLabel,
    userId: delegated.userId,
    clientId: delegated.clientId,
    capabilities: delegated.scopes as ApiKeyCapability[],
    accessExpiresAt: delegated.accessExpiresAt,
  };
}
