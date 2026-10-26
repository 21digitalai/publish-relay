import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import { resolveFanvuePaymentCallback } from './fanvue-payment-callback.repository.js';
import {
  FanvuePaymentDeliveryRejectedError,
  recordFanvuePaymentDelivery,
} from './fanvue-payment-delivery.service.js';

const paramsSchema = z.strictObject({ handle: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const probeSchema = z.strictObject({
  type: z.literal('fanvue.webhook.verification'),
  timestamp: z.iso.datetime(),
});

/** Encapsulation keeps raw JSON parsing confined to this exact unauthenticated callback. */
export function registerFanvuePaymentWebhook(
  application: FastifyInstance,
  dependencies: { database: NodePgDatabase; keys: MasterKeyProvider },
): void {
  void application.register((scope, _options, done) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 1_048_576 },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );
    scope.post('/webhooks/fanvue/payments/:handle', async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const params = paramsSchema.safeParse(request.params);
      if (!params.success || !Buffer.isBuffer(request.body)) return reply.code(404).send();
      const resolved = await resolveFanvuePaymentCallback(
        dependencies.database,
        dependencies.keys,
        params.data.handle,
      );
      if (!resolved) return reply.code(404).send();
      const signatureHeader = request.headers['x-fanvue-signature'];
      const signature = typeof signatureHeader === 'string' ? signatureHeader : undefined;
      if (resolved.state === 'probe_pending') {
        if (signature) return reply.code(401).send();
        let probe: unknown;
        try {
          probe = JSON.parse(request.body.toString('utf8')) as unknown;
        } catch {
          return reply.code(401).send();
        }
        return reply.code(probeSchema.safeParse(probe).success ? 204 : 401).send();
      }
      try {
        await recordFanvuePaymentDelivery(dependencies.database, {
          subscription: resolved.subscription,
          rawBody: request.body,
          signatureHeader: signature,
        });
      } catch (error) {
        if (error instanceof FanvuePaymentDeliveryRejectedError) return reply.code(401).send();
        throw error;
      }
      return reply.code(204).send();
    });
    done();
  });
}
