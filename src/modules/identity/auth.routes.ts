import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuthIdentity, AuthService } from './auth.service.js';
import type { SessionResult } from './auth.service.js';
import { requireWorkspaceAction, type WorkspaceAction } from './authorization.js';
import { sessionCookieOptions, verifyCsrfToken } from './session.js';
import { validateMagicLinkRedirect } from './magic-link.js';

export const SESSION_COOKIE = 'publish_relay_session';
export const CSRF_COOKIE = 'publish_relay_csrf';
const credentialsSchema = z.object({ email: z.email(), password: z.string().min(12) });
const loginSchema = credentialsSchema.extend({ redirectPath: z.string().max(2_048).optional() });
const registrationSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(1).max(100),
  workspaceName: z.string().trim().min(1).max(100),
});
const workspaceProfileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i),
  timezone: z
    .string()
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format();
        return true;
      } catch {
        return false;
      }
    })
    .optional(),
});
const workspaceSwitchSchema = z.object({ workspaceId: z.uuid() });
const workspaceCreateSchema = z.object({ name: z.string().trim().min(1).max(100) });
const workspaceOrderSchema = z.object({ workspaceIds: z.array(z.uuid()).min(1).max(100) });

function parseSessionCookie(
  value: string | undefined,
): { workspaceId: string; token: string } | null {
  if (!value) return null;
  const separator = value.indexOf('.');
  if (separator < 1) return null;
  return { workspaceId: value.slice(0, separator), token: value.slice(separator + 1) };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  if (
    'message' in error &&
    typeof error.message === 'string' &&
    /duplicate key|unique constraint/i.test(error.message)
  )
    return true;
  return 'cause' in error && isUniqueViolation(error.cause);
}

export async function authenticateRequest(
  request: FastifyRequest,
  auth: AuthService,
): Promise<AuthIdentity | null> {
  const session = parseSessionCookie(request.cookies[SESSION_COOKIE]);
  return session ? auth.authenticate(session.workspaceId, session.token) : null;
}

export async function authorizeRequest(
  request: FastifyRequest,
  auth: AuthService,
  action: WorkspaceAction,
): Promise<AuthIdentity | null> {
  const identity = await authenticateRequest(request, auth);
  if (!identity) return null;
  requireWorkspaceAction(identity.role, action);
  return identity;
}

export function setSessionCookies(
  reply: FastifyReply,
  session: SessionResult,
  secureCookies: boolean,
): void {
  reply.setCookie(
    SESSION_COOKIE,
    `${session.workspaceId}.${session.token}`,
    sessionCookieOptions(secureCookies),
  );
  reply.setCookie(CSRF_COOKIE, session.csrfToken, {
    sameSite: 'lax',
    secure: secureCookies,
    path: '/',
  });
}

export function registerAuthRoutes(
  application: FastifyInstance,
  auth: AuthService,
  options: { secureCookies: boolean; shellHtml: string },
): void {
  application.register(cookie);

  application.post('/api/auth/register', async (request, reply) => {
    const input = registrationSchema.safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ data: null, error: 'Invalid registration details' });
    const session = await auth.register(
      input.data.displayName,
      input.data.email,
      input.data.password,
      input.data.workspaceName,
    );
    setSessionCookies(reply, session, options.secureCookies);
    return reply.code(201).send({
      data: { userId: session.userId, workspaceId: session.workspaceId, role: session.role },
      error: null,
    });
  });

  application.post('/api/auth/login', async (request, reply) => {
    const input = loginSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ data: null, error: 'Invalid login details' });
    let redirectPath: string;
    try {
      redirectPath = validateMagicLinkRedirect(input.data.redirectPath);
    } catch {
      return reply.code(400).send({ data: null, error: 'Invalid login continuation' });
    }
    const session = await auth.login(input.data.email, input.data.password);
    if (!session) return reply.code(401).send({ data: null, error: 'Invalid email or password' });
    setSessionCookies(reply, session, options.secureCookies);
    return {
      data: {
        userId: session.userId,
        workspaceId: session.workspaceId,
        role: session.role,
        redirectPath,
      },
      error: null,
    };
  });

  application.post('/api/auth/forgot-password', (_request, reply) =>
    reply.code(503).send({
      data: {
        status: 'unavailable',
        supportMessage: 'Password recovery is not available yet. Contact support for assistance.',
      },
      error: null,
    }),
  );

  application.post('/api/auth/logout', async (request, reply) => {
    const session = parseSessionCookie(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    await auth.logout(session.workspaceId, session.token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).clearCookie(CSRF_COOKIE, { path: '/' });
    return { data: { loggedOut: true }, error: null };
  });

  application.get('/api/auth/session', async (request, reply) => {
    const identity = await authenticateRequest(request, auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const profile = await auth.getShellProfile(identity);
    return profile
      ? { data: profile, error: null }
      : reply.code(404).send({ data: null, error: 'Account profile was not found' });
  });

  application.patch('/api/workspaces/current', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'workspace:manage');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const input = workspaceProfileSchema.safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ data: null, error: 'Invalid workspace profile' });
    try {
      const workspace = await auth.updateWorkspace(identity, {
        name: input.data.name,
        slug: input.data.slug,
        ...(input.data.timezone ? { timezone: input.data.timezone } : {}),
      });
      return { data: workspace, error: null };
    } catch (error) {
      if (isUniqueViolation(error))
        return reply.code(409).send({ data: null, error: 'Workspace URL is already in use' });
      throw error;
    }
  });

  application.get('/api/workspaces/current', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const workspace = await auth.getWorkspace(identity);
    return workspace
      ? { data: workspace, error: null }
      : reply.code(404).send({ data: null, error: 'Workspace was not found' });
  });

  application.get('/api/workspaces', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    return { data: { workspaces: await auth.listWorkspaces(identity) }, error: null };
  });

  application.post('/api/workspaces', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!verifyCsrfToken(request.cookies[CSRF_COOKIE], request.headers['x-csrf-token'] as string))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const input = workspaceCreateSchema.safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ data: null, error: 'Enter a workspace name' });
    return reply
      .code(201)
      .send({ data: await auth.createWorkspace(identity, input.data.name), error: null });
  });

  application.patch('/api/workspaces/order', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!verifyCsrfToken(request.cookies[CSRF_COOKIE], request.headers['x-csrf-token'] as string))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const input = workspaceOrderSchema.safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ data: null, error: 'Invalid workspace order' });
    try {
      await auth.reorderWorkspaces(identity, input.data.workspaceIds);
      return { data: { workspaceIds: input.data.workspaceIds }, error: null };
    } catch {
      return reply
        .code(400)
        .send({ data: null, error: 'Workspace order must include every workspace exactly once' });
    }
  });

  application.post('/api/workspaces/:workspaceId/switch', async (request, reply) => {
    const session = parseSessionCookie(request.cookies[SESSION_COOKIE]);
    const identity = await authenticateRequest(request, auth);
    if (!session || !identity)
      return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const input = workspaceSwitchSchema.safeParse(request.params);
    if (!input.success)
      return reply.code(404).send({ data: null, error: 'Workspace was not found' });
    const switched = await auth.switchWorkspace(identity, session.token, input.data.workspaceId);
    if (!switched) return reply.code(404).send({ data: null, error: 'Workspace was not found' });
    setSessionCookies(reply, switched, options.secureCookies);
    return {
      data: { workspace: { id: switched.workspaceId, slug: switched.slug, role: switched.role } },
      error: null,
    };
  });

  const protectedShell = async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.redirect('/login');
    return reply.type('text/html').send(options.shellHtml);
  };
  application.get('/app', protectedShell);
  application.get('/onboarding/*', protectedShell);
  application.get('/w/*', protectedShell);
}

export function registerPublicAuthShellRoutes(
  application: FastifyInstance,
  shellHtml: string,
): void {
  const publicShell = (_request: FastifyRequest, reply: FastifyReply) =>
    reply.type('text/html').send(shellHtml);
  application.get('/login', publicShell);
  application.get('/register', publicShell);
  application.get('/forgot-password', publicShell);
}
