import { expect, test } from '@playwright/test';

const JOB_ID = '00000000-0000-4000-8000-000000000911';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000912';

test('disabled existing adapter history remains visible without recovery actions', async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.PUBLISH_RELAY_ENABLED_ADAPTERS !== '',
    'This restart acceptance runs with the explicit-none server allowlist.',
  );
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registration = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Adapter Policy Owner',
      email: `adapter-policy-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Adapter Policy ${suffix}`,
    },
  });
  expect(registration.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const existingJob = {
    id: JOB_ID,
    state: 'needs_attention',
    needsAttention: true,
    scheduledAt: new Date().toISOString(),
    contentPreview: 'Existing Story history',
    providerAccount: {
      id: 'existing-snap-account',
      displayName: 'Existing Snap account',
      handle: '',
      provider: 'snapchat',
    },
    media: { count: 1, previewUrl: null },
  };
  await page.route('**/api/workflow/jobs?limit=100', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [existingJob], next: null }, error: null }),
    }),
  );
  await page.route(`**/api/workflow/jobs/${JOB_ID}`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          ...existingJob,
          content: { kind: 'story_image' },
          media: [],
          attempts: [
            {
              id: ATTEMPT_ID,
              attemptNumber: 1,
              outcome: 'unknown',
              providerRequestId: 'existing-snap-request',
              error: null,
              retryAt: null,
            },
          ],
          activity: [],
          providerResult: null,
        },
        error: null,
      }),
    }),
  );
  let recoveryRequests = 0;
  await page.route(`**/api/workflow/jobs/${JOB_ID}/snapchat-story-resolution`, (route) => {
    recoveryRequests += 1;
    return route.abort();
  });

  await page.goto(`/w/${workspace.data.slug}/queue`);
  await page.getByRole('button', { name: 'Needs attention', exact: true }).click();
  await page.locator('.queue-row').click();

  await expect(page.getByRole('heading', { name: 'Existing Snap account' })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'This adapter is disabled on this server' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record verified failure' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry now' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('disabled-existing-adapter-history.png') });
  expect(recoveryRequests).toBe(0);
});
