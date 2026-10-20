import { expect, test, type Route } from '@playwright/test';

const JOB_ID = '00000000-0000-4000-8000-000000000901';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000902';

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
  let resolved = false;
  await page.route(`**/api/workflow/jobs/${JOB_ID}`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          ...story,
          state: resolved ? 'failed' : 'dispatching',
          needsAttention: !resolved,
          content: { kind: 'story_image' },
          media: [],
          attempts: [
            {
              id: ATTEMPT_ID,
              attemptNumber: 1,
              outcome: resolved ? 'permanent' : 'unknown',
              providerRequestId: resolved ? null : 'snap-request-1',
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
  await page.route(`**/api/workflow/jobs/${JOB_ID}/snapchat-story-resolution`, (route) => {
    expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    expect(route.request().postDataJSON()).toMatchObject({
      outcome: 'failed',
      attemptId: ATTEMPT_ID,
      providerRequestId: 'snap-request-1',
      source: 'provider_support',
      finding: 'verified_absent',
      reference: 'support-case-12345',
    });
    resolved = true;
    return route.fulfill({
      contentType: 'application/json',
      body: '{"data":{"outcome":"failed","replayed":false},"error":null}',
    });
  });
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
  const session = (await (await page.request.get('/api/auth/session')).json()) as {
    data: { workspace: { role: string } };
  };
  const editorSession = (route: Route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: { ...session.data, workspace: { ...session.data.workspace, role: 'editor' } },
        error: null,
      }),
    });
  await page.route('**/api/auth/session', editorSession);
  await page.reload();
  await expect(page.getByText('Snapchat Story outcome needs verification')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record verified failure' })).toHaveCount(0);
  await page.unroute('**/api/auth/session', editorSession);
  await page.reload();
  await page.getByRole('button', { name: 'Evidence source' }).click();
  await page.getByRole('option', { name: 'Snapchat support' }).click();
  await page.getByRole('button', { name: 'Provider finding' }).click();
  await page.getByRole('option', { name: 'Snapchat verified the Story is absent' }).click();
  await page
    .getByRole('textbox', { name: 'Provider evidence reference' })
    .fill('support-case-12345');
  await page.getByRole('button', { name: 'Record verified failure' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep Needs attention' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Record verified failure' }).click();
  await page.getByRole('button', { name: 'Confirm verified failure' }).click();
  await expect(page.locator('.job-detail .job-status')).toHaveText(/Failed/);
  await expect(page.getByRole('button', { name: 'Record verified failure' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View post' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.job-detail .job-status')).toHaveText(/Failed/);
  await page.screenshot({ path: testInfo.outputPath('story-verified-failed.png') });
});
