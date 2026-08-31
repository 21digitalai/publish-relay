import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { errorResponseSchema, openApiJsonSchema, successResponseSchema } from './contract.js';

const accountSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  workspaceLabel: z.string().min(1),
  prefix: z.string().min(1),
  capabilities: z.array(z.string()),
  expiresAt: z.date().nullable(),
});

export function apiV1OpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Publish Relay API', version: '1.0.0' },
    paths: {
      '/api/v1/account': {
        get: {
          operationId: 'getAccount',
          security: [{ bearerAuth: [], workspace: [] }],
          responses: {
            '200': {
              description: 'Authenticated API key identity',
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(accountSchema)),
                },
              },
            },
            '401': {
              description: 'Authentication required',
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        workspace: { type: 'apiKey', in: 'header', name: 'X-Publish-Relay-Workspace' },
      },
    },
  };
}

export function registerApiDocumentationRoute(application: FastifyInstance): void {
  application.get('/api/v1/openapi.json', () => apiV1OpenApiDocument());
}
