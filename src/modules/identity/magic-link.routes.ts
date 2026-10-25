import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { setSessionCookies } from './auth.routes.js';
import { validateMagicLinkRedirect } from './magic-link.js';
import type { MagicLinkService } from './magic-link.service.js';

const requestSchema = z.object({
  email: z.email(),
  redirectPath: z.string().max(2_048).optional(),
});
const verifySchema = z.object({
  token: z
    .string()
    .min(32)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
});

function verificationBody(body: unknown, contentType: string | undefined): unknown {
  if (!contentType?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return body;
  if (typeof body !== 'string' || body.length > 2_048) return body;
  return Object.fromEntries(new URLSearchParams(body));
}

function confirmationPage(token: string, path: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Continue to Publish Relay</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 25%,#31235b 0%,#11111c 58%);color:#f7f5ff;font:16px/1.5 system-ui,sans-serif}.auth-confirmation{box-sizing:border-box;width:min(440px,calc(100vw - 32px));padding:36px;border:1px solid #51466b;border-radius:18px;background:#1e1b2c;box-shadow:0 24px 64px #0006}.auth-confirmation h1{font-size:28px;line-height:1.2;margin:0 0 12px}.auth-confirmation p{color:#cfc9df;margin:0 0 28px}.auth-confirmation-submit{width:100%;min-height:48px;border:0;border-radius:10px;background:#a3ff4f;color:#132007;font:600 16px system-ui,sans-serif;cursor:pointer}.auth-confirmation-submit:focus-visible{outline:3px solid #a98bff;outline-offset:3px}</style>
</head><body><main class="auth-confirmation"><h1>Continue to Publish Relay</h1><p>Press Continue to sign in with your email link.</p><form method="post" action="${path}"><input type="hidden" name="token" value="${token}"><button class="auth-confirmation-submit" type="submit">Continue</button><p role="alert" hidden>We could not complete sign-in. Please try again.</p></form></main><script>
try { history.replaceState(null,"",${JSON.stringify(path)}); } catch {}
const form = document.querySelector('form');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  const error = form.querySelector('[role="alert"]');
  button.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch(form.action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: form.elements.namedItem('token').value }),
    });
    const destination = new URL(response.url);
    if (!response.redirected || destination.origin !== location.origin) throw new Error('Invalid sign-in response');
    location.replace(destination.pathname + destination.search + destination.hash);
  } catch {
    button.disabled = false;
    error.hidden = false;
  }
});
</script></body></html>`;
}

function confirmationHeaders(reply: FastifyReply): void {
  void reply.header('Cache-Control', 'no-store, private');
  void reply.header('Referrer-Policy', 'no-referrer');
  void reply.header('X-Content-Type-Options', 'nosniff');
  void reply.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'",
  );
}

export function registerMagicLinkRoutes(
  application: FastifyInstance,
  magicLinks: MagicLinkService,
  options: { secureCookies: boolean },
): void {
  if (!application.hasContentTypeParser('application/x-www-form-urlencoded'))
    application.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 2_048 },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );
  application.post('/api/auth/magic-link/request', async (request, reply) => {
    const input = requestSchema.safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ data: null, error: 'Enter a valid email address' });
    let redirectPath: string;
    try {
      redirectPath = validateMagicLinkRedirect(input.data.redirectPath);
    } catch {
      return reply.code(400).send({ data: null, error: 'Enter a valid redirect path' });
    }
    const result = await magicLinks.requestAccess({
      email: input.data.email,
      redirectPath,
      networkKey: request.ip,
      userAgent: request.headers['user-agent'] ?? '',
      correlationId: request.id,
    });
    return reply.code(202).send({
      data: {
        accepted: true,
        message: 'If the email can be used, a sign-in link is on its way.',
        ...(result.developmentUrl ? { developmentUrl: result.developmentUrl } : {}),
      },
      error: null,
    });
  });

  for (const [path, invalidPath] of [
    ['/api/auth/magic-link/verify', '/login?magicLink=invalid'],
    ['/api/auth/magic-link/verify-signup', '/register?magicLink=invalid'],
  ] as const) {
    application.get(path, (request, reply) => {
      confirmationHeaders(reply);
      const input = verifySchema.safeParse(request.query);
      if (!input.success) return reply.redirect(invalidPath);
      return reply.type('text/html; charset=utf-8').send(confirmationPage(input.data.token, path));
    });
    application.post(path, async (request, reply) => {
      confirmationHeaders(reply);
      const input = verifySchema.safeParse(
        verificationBody(request.body, request.headers['content-type']),
      );
      if (!input.success) return reply.redirect(invalidPath);
      const session = await magicLinks.verify({ token: input.data.token });
      if (!session) return reply.redirect('/login?magicLink=invalid');
      setSessionCookies(reply, session, options.secureCookies);
      return reply.redirect(session.redirectPath);
    });
  }
}
