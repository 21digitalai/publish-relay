import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import { listFanvuePaymentSignals } from './fanvue-payment-receipt.repository.js';

const paramsSchema = z.strictObject({ accountId: z.uuid() });
const querySchema = z.strictObject({ cursor: z.string().max(512).optional() });
const cursorSchema = z.strictObject({ eventAt: z.iso.datetime(), id: z.uuid() });
const PAGE_SIZE = 50;

function readCursor(value: string | undefined): z.infer<typeof cursorSchema> | null {
  if (!value) return null;
  const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  return cursorSchema.parse(parsed);
}

export function registerFanvuePaymentRoutes(
  application: FastifyInstance,
  dependencies: {
    database: NodePgDatabase;
    apiKeys: ApiKeyService;
    rateLimiter: ApiRateLimiter;
    delegatedAuthorization?: DelegatedAuthorizationService;
  },
): void {
  application.get('/api/v1/fanvue/accounts/:accountId/payment-signals', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      const principal = await authorizeMachineRequest(
        request,
        dependencies.apiKeys,
        dependencies.delegatedAuthorization,
        'fanvue:payments:read',
      );
      if (!principal)
        return await reply.code(401).send({ data: null, error: 'Authentication required' });
      const decision = dependencies.rateLimiter.check(
        principal.workspaceId,
        principal.actorId,
        'read',
      );
      if (!decision.allowed)
        return await reply.code(429).send({ data: null, error: 'Rate limit exceeded' });
      const params = paramsSchema.safeParse(request.params);
      const query = querySchema.safeParse(request.query);
      if (!params.success || !query.success)
        return await reply.code(400).send({ data: null, error: 'Invalid account or cursor' });
      let cursor: ReturnType<typeof readCursor>;
      try {
        cursor = readCursor(query.data.cursor);
      } catch {
        return await reply.code(400).send({ data: null, error: 'Invalid cursor' });
      }
      const rows = await listFanvuePaymentSignals(dependencies.database, {
        workspaceId: principal.workspaceId,
        accountId: params.data.accountId,
        limit: PAGE_SIZE + 1,
        ...(cursor ? { before: { eventAt: new Date(cursor.eventAt), id: cursor.id } } : {}),
      });
      const page = rows.slice(0, PAGE_SIZE);
      const last = page.at(-1);
      const nextCursor =
        rows.length > PAGE_SIZE && last
          ? Buffer.from(
              JSON.stringify({ eventAt: last.eventAt.toISOString(), id: last.id }),
            ).toString('base64url')
          : null;
      return await reply.send({
        data: {
          items: page.map((row) => ({
            eventId: row.eventId,
            fanUuid: row.fanUuid,
            invoiceId: row.invoiceId,
            source: row.source,
            grossMinor: row.grossMinor,
            currency: row.currency,
            paidAt: row.paidAt?.toISOString() ?? null,
            eventAt: row.eventAt.toISOString(),
            postUuid: row.postUuid,
            messageUuid: row.messageUuid,
            tipContext: row.tipContext,
          })),
          nextCursor,
        },
        error: null,
      });
    } catch (error) {
      if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
        return await reply
          .code(403)
          .send({ data: null, error: 'Payment read capability is required' });
      throw error;
    }
  });
}
