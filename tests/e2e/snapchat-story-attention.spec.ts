import { expect, test } from '@playwright/test';

const JOB_ID = '00000000-0000-4000-8000-000000000901';

test('Story unknown outcome appears under Needs attention without a retry action', async ({
  page,
}, testInfo) => {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registration = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Story Owner',
      email: `story-attention-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Story ${suffix}`,
    },
  });
  expect(registration.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const story = {
    id: JOB_ID,
    state: 'dispatching',
    needsAttention: true,
    scheduledAt: new Date().toISOString(),
    contentPreview: 'Story image',
    providerAccount: {
      id: 'snap-account',
      displayName: 'Snap Owner',
      handle: '',
      provider: 'snapchat',
    },
    media: { count: 1, previewUrl: null },
  };
  await page.route('**/api/workflow/jobs?limit=100', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [story], next: null }, error: null }),
    }),
  );
  await page.route(`**/api/workflow/jobs/${JOB_ID}`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          ...story,
          content: { kind: 'story_image' },
          media: [],
          attempts: [
            {
              id: 'attempt-1',
              attemptNumber: 1,
              outcome: 'unknown',
              providerRequestId: 'snap-request-1',
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
  await page.goto(`/w/${workspace.data.slug}/queue`);
  await expect(page.locator('.queue-row .job-status')).toHaveText(/Needs attention/);
  await page.getByRole('button', { name: 'Upcoming', exact: true }).click();
  await expect(page.locator('.queue-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Needs attention', exact: true }).click();
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('story-needs-attention-queue.png') });
  await page.locator('.queue-row').click();
  await expect(page.getByText('Snapchat Story outcome needs verification')).toBeVisible();
  await expect(page.getByText(/Do not retry: that could publish a duplicate/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry now' })).toHaveCount(0);
  await page.getByText('Technical details').click();
  await expect(page.getByText(/snap-request-1/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('story-needs-attention-detail.png') });
});
