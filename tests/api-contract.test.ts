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
        '/api/v1/account': {
          get: {
            operationId: 'getAccount',
            responses: { '200': { description: 'Authenticated API key identity' } },
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
