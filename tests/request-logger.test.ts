import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { requestLoggerOptions } from '../src/application/request-logger.js';

interface LogRecord {
  msg?: string;
  level?: number;
  req?: { url?: string };
  reqId?: string;
}

describe('request logger', () => {
  it('keeps request correlation and path without query credentials in request and error logs', async () => {
    const lines: string[] = [];
    const application = Fastify({
      logger: {
        ...requestLoggerOptions,
        stream: { write: (line) => lines.push(line) },
      },
    });
    application.get('/api/auth/magic-link/verify', () => {
      throw new Error('Verification failed');
    });

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
    } finally {
      await application.close();
    }
  });
});
