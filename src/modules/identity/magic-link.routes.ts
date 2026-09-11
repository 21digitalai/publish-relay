import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { setSessionCookies } from './auth.routes.js';
import type { MagicLinkService } from './magic-link.service.js';

const requestSchema = z.object({
  email: z.email(),
  redirectPath: z.string().max(2_048).optional(),
});
const verifySchema = z.object({ token: z.string().min(32).max(256) });

export function registerMagicLinkRoutes(
  application: FastifyInstance,
  magicLinks: MagicLinkService,
  options: { secureCookies: boolean },
): void {
  application.post('/api/auth/magic-link/request', async (request, reply) => {
    const input = requestSchema.safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ data: null, error: 'Enter a valid email address' });
    const result = await magicLinks.requestLogin({
      email: input.data.email,
      ...(input.data.redirectPath ? { redirectPath: input.data.redirectPath } : {}),
      networkKey: request.ip,
      userAgent: request.headers['user-agent'] ?? '',
      correlationId: request.id,
    });
    return reply.code(202).send({
      data: {
        accepted: true,
        message: 'If an account exists, a sign-in link is on its way.',
        ...(result.developmentUrl ? { developmentUrl: result.developmentUrl } : {}),
      },
      error: null,
    });
  });

  application.get('/api/auth/magic-link/verify', async (request, reply) => {
    const input = verifySchema.safeParse(request.query);
    if (!input.success) return reply.redirect('/login?magicLink=invalid');
    const session = await magicLinks.verifyLogin({
      token: input.data.token,
      userAgent: request.headers['user-agent'] ?? '',
    });
    if (!session) return reply.redirect('/login?magicLink=invalid');
    setSessionCookies(reply, session, options.secureCookies);
    return reply.redirect(session.redirectPath);
  });
}
