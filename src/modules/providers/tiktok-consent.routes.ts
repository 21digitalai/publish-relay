import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { WorkspaceAuthorizationError } from '../identity/authorization.js';
import { verifyCsrfToken } from '../identity/session.js';
import {
  getTikTokPublicationConsent,
  issueTikTokPublicationConsent,
  TikTokConsentInvalidError,
  TikTokConsentNotFoundError,
  tiktokConsentRequestSchema,
} from './tiktok-consent.service.js';

const receiptParamsSchema = z.strictObject({ receiptId: z.uuid() });
const RECOVERY_MESSAGE =
  'TikTok consent is no longer valid; refresh the destination and confirm again';

export function registerTikTokConsentRoutes(
  application: FastifyInstance,
  dependencies: { auth: AuthService; database: NodePgDatabase },
): void {
  application.post('/api/workflow/tiktok-consents', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      const identity = await authorizeRequest(request, dependencies.auth, 'content:write');
      if (!identity)
        return await reply.code(401).send({ data: null, error: 'Authentication required' });
      if (
        !verifyCsrfToken(
          request.cookies[CSRF_COOKIE],
          request.headers['x-csrf-token'] as string | undefined,
        )
      )
        return await reply.code(403).send({ data: null, error: 'CSRF validation failed' });
      const parsed = tiktokConsentRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return await reply
          .code(400)
          .send({ data: null, error: 'Explicit TikTok consent fields are required' });
      const receipt = await issueTikTokPublicationConsent(dependencies.database, {
        ...parsed.data,
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        actor: { type: 'user', id: identity.userId },
      });
      return await reply.code(201).send({ data: receipt, error: null });
    } catch (error) {
      if (error instanceof WorkspaceAuthorizationError)
        return await reply
          .code(403)
          .send({ data: null, error: 'You cannot consent in this workspace' });
      if (error instanceof TikTokConsentInvalidError)
        return await reply.code(409).send({ data: null, error: RECOVERY_MESSAGE });
      throw error;
    }
  });

  application.get('/api/workflow/tiktok-consents/:receiptId', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
      if (!identity)
        return await reply.code(401).send({ data: null, error: 'Authentication required' });
      const params = receiptParamsSchema.safeParse(request.params);
      if (!params.success)
        return await reply.code(400).send({ data: null, error: 'Invalid consent receipt' });
      const receipt = await getTikTokPublicationConsent(dependencies.database, {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        receiptId: params.data.receiptId,
      });
      return await reply.send({ data: receipt, error: null });
    } catch (error) {
      if (error instanceof WorkspaceAuthorizationError)
        return await reply
          .code(403)
          .send({ data: null, error: 'You cannot read consent in this workspace' });
      if (error instanceof TikTokConsentNotFoundError)
        return await reply.code(404).send({ data: null, error: 'Consent receipt was not found' });
      if (error instanceof TikTokConsentInvalidError)
        return await reply.code(409).send({ data: null, error: RECOVERY_MESSAGE });
      throw error;
    }
  });
}
