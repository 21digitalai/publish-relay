import type { FastifyLoggerOptions } from 'fastify';

// Query strings can carry one-time login links and OAuth credentials.
export const requestLoggerOptions: FastifyLoggerOptions = {
  serializers: {
    req(request) {
      return {
        method: request.method,
        url: request.url.split(/[?#]/, 1)[0] ?? '/',
        remoteAddress: request.ip,
      };
    },
  },
};
