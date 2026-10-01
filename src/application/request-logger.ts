import type { FastifyInstance, FastifyLoggerOptions } from 'fastify';

function requestPath(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? '/';
  return path.replace(/^\/provider-media\/tiktok(?:\/.*)?$/, '/provider-media/tiktok/[REDACTED]');
}

export function registerRedactedNotFoundHandler(application: FastifyInstance): void {
  application.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: `Route ${request.method}:${requestPath(request.url)} not found`,
    });
  });
}

// Query strings can carry one-time login links and OAuth credentials.
export const requestLoggerOptions: FastifyLoggerOptions = {
  serializers: {
    req(request) {
      return {
        method: request.method,
        url: requestPath(request.url),
        remoteAddress: request.ip,
      };
    },
  },
};
