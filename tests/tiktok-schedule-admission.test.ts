import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

vi.mock('../src/modules/identity/auth.routes.js', () => ({
  authorizeRequest: vi.fn(() => Promise.resolve({ workspaceId: 'fixture', userId: 'fixture' })),
  CSRF_COOKIE: 'publish_relay_csrf',
}));

import { registerTikTokScheduleRoutes } from '../src/modules/providers/tiktok-schedule.routes.js';

it('rejects authenticated TikTok scheduling before mutation when runtime is disabled', async () => {
  const app = Fastify();
  registerTikTokScheduleRoutes(app, {
    auth: {} as never,
    database: {} as never,
    actionPolicy: {} as never,
    enabled: false,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workflow/tiktok-schedules',
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: string }>().error).toBe('TikTok publishing is unavailable');
  } finally {
    await app.close();
  }
});
