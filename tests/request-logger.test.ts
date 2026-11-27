import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  registerRedactedErrorHandler,
  registerRedactedNotFoundHandler,
  requestLoggerOptions,
} from '../src/application/request-logger.js';

interface LogRecord {
  msg?: string;
  level?: number;
  req?: { url?: string };
  reqId?: string;
}

describe('request logger', () => {
  it('preserves parser size rejection with production redaction enabled', async () => {
    const application = Fastify();
    registerRedactedErrorHandler(application);
    application.addContentTypeParser(
      'image/png',
      { parseAs: 'buffer', bodyLimit: 16 },
      (_request, body, done) => {
        done(null, body);
      },
    );
    application.post('/api/v1/media', (_request, reply) => reply.code(401).send());
    try {
      const atLimit = await application.inject({
        method: 'POST',
        url: '/api/v1/media',
        headers: { 'content-type': 'image/png' },
        payload: Buffer.alloc(16),
      });
      expect(atLimit.statusCode).toBe(401);
      const oversized = await application.inject({
        method: 'POST',
        url: '/api/v1/media',
        headers: { 'content-type': 'image/png' },
        payload: Buffer.alloc(17),
      });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json()).toEqual({
        statusCode: 413,
        error: 'Payload Too Large',
        message: 'Payload Too Large',
      });
    } finally {
      await application.close();
    }
  });
  it('keeps request correlation and path without query credentials in request and error logs', async () => {
    const lines: string[] = [];
    const application = Fastify({
      logger: {
        ...requestLoggerOptions,
        stream: { write: (line) => lines.push(line) },
      },
    });
    application.get('/api/auth/magic-link/verify', () => {
      throw new Error('database query params password_hash=synthetic-secret');
    });
    registerRedactedErrorHandler(application);
    registerRedactedNotFoundHandler(application);

    try {
      await application.inject({
        method: 'GET',
        url: '/api/auth/magic-link/verify?token=synthetic-secret&next=%2Fapp',
      });
      const records = lines.map((line) => JSON.parse(line) as LogRecord);
      expect(records.some((record) => record.msg === 'incoming request')).toBe(true);
      expect(records.some((record) => record.level === 50)).toBe(true);
      expect(records.every((record) => !JSON.stringify(record).includes('synthetic-secret'))).toBe(
        true,
      );
      expect(records.some((record) => record.req?.url === '/api/auth/magic-link/verify')).toBe(
        true,
      );
      expect(records.some((record) => typeof record.reqId === 'string')).toBe(true);
      const missing = await application.inject({
        method: 'GET',
        url: '/__logging_canary_20261001?token=SYNTHETIC_REDACTION_PROBE_20261001',
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 'Route GET:/__logging_canary_20261001 not found',
      });
      const allRecords = lines.map((line) => JSON.parse(line) as LogRecord);
      expect(
        allRecords.every(
          (record) => !JSON.stringify(record).includes('SYNTHETIC_REDACTION_PROBE_20261001'),
        ),
      ).toBe(true);
      const bearerPath = await application.inject({
        method: 'GET',
        url: '/provider-media/tiktok/grant-id/SYNTHETIC_TIKTOK_BEARER/extra',
      });
      expect(bearerPath.statusCode).toBe(404);
      expect(JSON.stringify(bearerPath.json())).not.toContain('SYNTHETIC_TIKTOK_BEARER');
      expect(lines.join('')).not.toContain('SYNTHETIC_TIKTOK_BEARER');
      const fanvuePath = await application.inject({
        method: 'GET',
        url: '/webhooks/fanvue/payments/SYNTHETIC_FANVUE_BEARER/near-match',
      });
      expect(fanvuePath.statusCode).toBe(404);
      expect(JSON.stringify(fanvuePath.json())).not.toContain('SYNTHETIC_FANVUE_BEARER');
      expect(lines.join('')).not.toContain('SYNTHETIC_FANVUE_BEARER');
    } finally {
      await application.close();
    }
  });
});
