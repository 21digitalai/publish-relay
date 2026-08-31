import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createPostRequestSchema, postMutationResponseSchema } from '../content/post.contract.js';
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
            '429': {
              description: 'Rate limit exceeded',
              headers: {
                'Retry-After': { schema: { type: 'integer', minimum: 1 } },
                'X-RateLimit-Limit': { schema: { type: 'integer', minimum: 1 } },
                'X-RateLimit-Remaining': { schema: { type: 'integer', minimum: 0 } },
              },
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
          },
        },
      },
      '/api/v1/posts': {
        post: {
          operationId: 'createPost',
          security: [{ bearerAuth: [], workspace: [] }],
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 8, maxLength: 200 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: openApiJsonSchema(createPostRequestSchema) },
            },
          },
          responses: {
            '201': {
              description: 'Post and independent publication jobs created',
              headers: {
                'Idempotency-Replayed': { schema: { type: 'boolean' } },
              },
              content: {
                'application/json': {
                  schema: openApiJsonSchema(successResponseSchema(postMutationResponseSchema)),
                },
              },
            },
            '400': {
              description: 'Invalid request or idempotency key',
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
            '401': {
              description: 'Authentication required',
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
            '403': {
              description: 'Missing schedules:write capability',
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
            '409': {
              description: 'Idempotency key reused for a different request',
              content: {
                'application/json': { schema: openApiJsonSchema(errorResponseSchema) },
              },
            },
            '429': {
              description: 'Mutation rate limit exceeded',
              headers: {
                'Retry-After': { schema: { type: 'integer', minimum: 1 } },
                'X-RateLimit-Limit': { schema: { type: 'integer', minimum: 1 } },
                'X-RateLimit-Remaining': { schema: { type: 'integer', minimum: 0 } },
              },
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
