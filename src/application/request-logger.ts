import type { FastifyInstance, FastifyLoggerOptions } from 'fastify';

function requestPath(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? '/';
  return path
    .replace(/^\/provider-media\/tiktok(?:\/.*)?$/, '/provider-media/tiktok/[REDACTED]')
    .replace(/^\/webhooks\/fanvue\/payments(?:\/.*)?$/, '/webhooks/fanvue/payments/[REDACTED]');
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

export function registerRedactedErrorHandler(application: FastifyInstance): void {
  application.setErrorHandler((error, request, reply) => {
    // Parser failures happen before route error handling; keep the size contract
    // without exposing arbitrary exception messages or weakening redaction.
    if (error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        statusCode: 413,
        error: 'Payload Too Large',
        message: 'Payload Too Large',
      });
    }
    request.log.error(
      { requestId: request.id, method: request.method, url: requestPath(request.url) },
      'request failed',
    );
    return reply.code(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
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
