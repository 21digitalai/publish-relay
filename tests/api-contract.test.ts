import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CursorCodec,
  errorEnvelope,
  errorResponseSchema,
  InvalidCursorError,
  openApiJsonSchema,
  successEnvelope,
  successResponseSchema,
} from '../src/modules/api/contract.js';
import { apiV1OpenApiDocument } from '../src/modules/api/openapi.js';
import { z } from 'zod';

describe('API v1 contract', () => {
  it('builds stable success and error envelopes with request IDs', () => {
    expect(successEnvelope({ id: 'post-1' }, 'request-1')).toEqual({
      success: true,
      data: { id: 'post-1' },
      meta: { requestId: 'request-1' },
    });
    expect(errorEnvelope('invalid_request', 'Invalid request', 'request-2')).toEqual({
      success: false,
      error: { code: 'invalid_request', message: 'Invalid request', requestId: 'request-2' },
    });
  });

  it('uses the runtime schemas as the OpenAPI response source', () => {
    const successSchema = successResponseSchema(z.object({ id: z.string() }));
    expect(successSchema.parse(successEnvelope({ id: 'post-1' }, 'request-1'))).toMatchObject({
      success: true,
    });
    expect(
      errorResponseSchema.parse(errorEnvelope('invalid', 'Invalid', 'request-2')),
    ).toMatchObject({
      success: false,
    });
    expect(openApiJsonSchema(successSchema)).toMatchObject({
      type: 'object',
      required: ['success', 'data', 'meta'],
    });
  });

  it('publishes the API v1 account contract and authentication schemes', () => {
    expect(apiV1OpenApiDocument()).toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/api/v1/destinations': {
          get: { operationId: 'listDestinations', responses: { '200': {}, '403': {} } },
        },
        '/api/v1/account': {
          get: {
            operationId: 'getAccount',
            responses: {
              '200': { description: 'Authenticated API key or delegated connection identity' },
            },
          },
        },
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
          workspace: { name: 'X-Publish-Relay-Workspace' },
        },
      },
    });
  });

  it('documents every live destination provider, including LinkedIn', () => {
    const paths = apiV1OpenApiDocument().paths as Record<string, unknown>;
    const document = JSON.stringify(paths['/api/v1/destinations']);
    for (const provider of ['x', 'youtube', 'linkedin', 'instagram', 'facebook_page'])
      expect(document).toContain(provider);
    expect(document).toContain('publishing_unavailable');
  });

  it('documents the Fanvue comment send command and its outcome states', () => {
    const paths = apiV1OpenApiDocument().paths as Record<string, unknown>;
    const command = paths['/api/v1/fanvue/accounts/{accountId}/posts/{postUuid}/comments'] as {
      post: {
        operationId: string;
        requestBody: { content: Record<string, { schema: { required: string[] } }> };
        responses: Record<string, unknown>;
      };
    };
    expect(command.post.operationId).toBe('sendFanvueComment');
    expect(command.post.requestBody.content['application/json']?.schema.required).toEqual([
      'text',
      'clientActionId',
    ]);
    expect(Object.keys(command.post.responses)).toEqual(
      expect.arrayContaining(['201', '202', '403', '409', '429']),
    );
    expect(JSON.stringify(command.post.responses['201'])).toContain('commentUuid');
  });

  it('documents the bounded Unified Instagram schedule machine contract', () => {
    const paths = apiV1OpenApiDocument().paths as Record<string, any>;
    const collection = paths['/api/v1/destinations/{accountId}/instagram-unified-schedules'];
    const detail = paths['/api/v1/destinations/{accountId}/instagram-unified-schedules/{intentId}'];
    expect(collection.post.operationId).toBe('scheduleInstagramUnifiedReply');
    expect(collection.get.operationId).toBe('listInstagramUnifiedSchedules');
    expect(detail.get.operationId).toBe('getInstagramUnifiedSchedule');
    expect(detail.delete.operationId).toBe('cancelInstagramUnifiedSchedule');
    expect(JSON.stringify(collection.post)).toContain('schedules:write');
    expect(JSON.stringify(collection.get)).toContain('schedules:read');
    expect(JSON.stringify(detail.delete)).toContain('schedules:write');
    expect(JSON.stringify(collection)).not.toContain('accessToken');
    expect(JSON.stringify(collection)).not.toContain('requestFingerprint');
  });

  it('documents the Fanvue vault catalog cursor contract', () => {
    const paths = apiV1OpenApiDocument().paths as Record<string, unknown>;
    const catalog = paths['/api/v1/fanvue/accounts/{accountId}/vault/catalog/{folderName}'] as {
      get: { parameters: { name: string; in: string; schema: Record<string, unknown> }[] };
    };
    const queryParameters = catalog.get.parameters.filter((parameter) => parameter.in === 'query');
    expect(queryParameters).toEqual([
      { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 1024 } },
      { name: 'size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
    ]);
  });

  it('documents versioned provider-specific post request branches', () => {
    const paths = apiV1OpenApiDocument().paths as Record<string, unknown>;
    const post = paths['/api/v1/posts'] as {
      post: { requestBody: { content: Record<string, { schema: unknown }> } };
    };
    const schema = post.post.requestBody.content['application/json']?.schema as {
      anyOf: [
        {
          anyOf: {
            properties: {
              destination: { properties: { provider: { const: string } } };
              content: {
                properties?: { schemaVersion: { const: number } };
                additionalProperties?: boolean;
                oneOf?: {
                  properties: { schemaVersion: { const: number } };
                  additionalProperties: boolean;
                }[];
              };
              providerAccountIds: unknown;
            };
          }[];
        },
      ];
    };
    const branches = schema.anyOf[0].anyOf;
    expect(
      branches.map((branch) => branch.properties.destination.properties.provider.const),
    ).toEqual(['x', 'youtube', 'tiktok', 'instagram', 'facebook_page', 'linkedin', 'fanvue']);
    for (const branch of branches) {
      const contentBranches = branch.properties.content.oneOf ?? [branch.properties.content];
      for (const content of contentBranches) {
        expect(content.properties?.schemaVersion.const).toBe(1);
        expect(content.additionalProperties).toBe(false);
      }
      expect(branch.properties.providerAccountIds).toEqual({ not: {} });
    }
  });

  it('publishes provider-neutral post collection and direct-resource contracts', () => {
    expect(apiV1OpenApiDocument()).toMatchObject({
      paths: {
        '/api/v1/posts': { get: { operationId: 'listPosts', responses: { '200': {}, '400': {} } } },
        '/api/v1/posts/{postId}': {
          get: { operationId: 'getPost', responses: { '200': {}, '404': {} } },
        },
        '/api/v1/jobs/{jobId}': {
          get: { operationId: 'getJob', responses: { '200': {}, '404': {} } },
        },
        '/api/v1/jobs/{jobId}/retry': {
          post: { operationId: 'retryPublication', responses: { '202': {}, '409': {} } },
        },
      },
    });
  });

  it('round trips a signed cursor with normalized filters', () => {
    const codec = new CursorCodec(randomBytes(32));
    const now = new Date('2026-08-31T12:00:00.000Z');
    const cursor = codec.encode(
      '2026-08-31T11:00:00.000Z:post-1',
      { status: 'queued', limit: 25 },
      now,
    );
    expect(codec.decode(cursor, { limit: 25, status: 'queued' }, now)).toEqual({
      position: '2026-08-31T11:00:00.000Z:post-1',
    });
    expect(cursor).not.toContain('post-1');
  });

  it('rejects malformed, tampered, expired, and filter-mismatched cursors', () => {
    const codec = new CursorCodec(randomBytes(32), 1000);
    const now = new Date('2026-08-31T12:00:00.000Z');
    const cursor = codec.encode('position', { status: 'queued' }, now);
    const cases: [string, Record<string, string> | undefined, Date | undefined][] = [
      ['not-a-cursor', undefined, undefined],
      [`${cursor.slice(0, -1)}x`, undefined, undefined],
      [cursor, { status: 'published' }, undefined],
      [cursor, undefined, new Date(now.getTime() + 1001)],
    ];
    for (const [candidate, filters, at] of cases)
      expect(() => codec.decode(candidate, filters ?? { status: 'queued' }, at ?? now)).toThrow(
        InvalidCursorError,
      );
  });
});
