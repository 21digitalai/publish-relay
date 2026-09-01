import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function establishWorkspaceSession(page: Page) {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const response = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Relay Owner',
      email: `owner-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Atlas ${suffix}`,
    },
  });
  expect(response.ok()).toBe(true);
}

async function mockConnectedAccounts(page: Page) {
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: '00000000-0000-4000-8000-000000000201',
              provider: 'x',
              displayName: 'Daily Viber (@dailyviber)',
              status: 'active',
              updatedAt: '2026-09-01T00:00:00Z',
            },
            {
              id: '00000000-0000-4000-8000-000000000202',
              provider: 'x',
              displayName: 'Studio Notes (@studionotes)',
              status: 'reconnect_required',
              updatedAt: '2026-08-29T00:00:00Z',
            },
            {
              id: '00000000-0000-4000-8000-000000000203',
              provider: 'instagram',
              displayName: 'Mira Studio (@mirastudio)',
              status: 'active',
              updatedAt: '2026-09-01T00:00:00Z',
            },
          ],
        },
        error: null,
      }),
    }),
  );
}

test('renders the login surface and reports an inline authentication error', async ({
  page,
}, testInfo) => {
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: 'Invalid email or password' }),
    }),
  );
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in to your cockpit' })).toBeVisible();
  await page.getByLabel('Email').fill('owner@example.test');
  await page.getByLabel('Password').fill('incorrect-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');
  await page.screenshot({ path: testInfo.outputPath('auth-error.png'), fullPage: true });
});

test('renders the honest recovery unavailable state', async ({ page }) => {
  await page.goto('/forgot-password');
  await expect(page.getByRole('heading', { name: 'Recovery is not available yet' })).toBeVisible();
  await expect(page.getByText('We will not claim that an email was sent')).toBeVisible();
});

test('registers, persists the first workspace update, and reloads the protected onboarding route', async ({
  browser,
  page,
}, testInfo) => {
  const suffix = Math.random().toString(36).slice(2);
  await page.goto('/register');
  await page.getByLabel('Name', { exact: true }).fill('Relay Owner');
  await page.getByLabel('Workspace name').fill(`Atlas Studio ${suffix}`);
  await page.getByLabel('Email').fill(`owner-${suffix}@example.test`);
  await page.getByLabel('Password').fill('long-password-123!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding\/workspace$/);
  await page.getByLabel('Workspace name').fill('Atlas Publishing');
  const collisionContext = await browser.newContext();
  const collisionResponse = await collisionContext.request.post('/api/auth/register', {
    data: {
      displayName: 'Collision Owner',
      email: `collision-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Atlas Publishing ${suffix}`,
    },
  });
  expect(collisionResponse.ok()).toBe(true);
  const collisionWorkspaceResponse = await collisionContext.request.get('/api/workspaces/current');
  expect(collisionWorkspaceResponse.ok()).toBe(true);
  const collisionWorkspace = (await collisionWorkspaceResponse.json()) as {
    data: { slug: string };
  };
  const conflictingSlug = collisionWorkspace.data.slug;
  const workspaceSlug = `${conflictingSlug}-owner`;
  await collisionContext.close();
  await page.getByLabel('Workspace URL').fill(conflictingSlug);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText('Workspace URL is already in use');
  await page.getByLabel('Workspace URL').fill(workspaceSlug);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Connect your first account' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Name your workspace' })).toBeVisible();
  await expect(page.getByLabel('Workspace name')).toHaveValue('Atlas Publishing');
  await expect(page.getByLabel('Workspace URL')).toHaveValue(workspaceSlug);
  await page.screenshot({ path: testInfo.outputPath('persisted-onboarding.png'), fullPage: true });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page).toHaveURL(`/w/${workspaceSlug}/accounts`);
});

test('filters accounts and opens a named disconnect confirmation', async ({ page }, testInfo) => {
  await establishWorkspaceSession(page);
  await mockConnectedAccounts(page);
  await page.goto('/w/atlas/accounts');
  await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible();
  await expect(page.getByText('Studio Notes')).toBeVisible();
  await page.getByPlaceholder('Search name or handle').fill('Mira');
  await expect(page.getByText('Mira Studio')).toBeVisible();
  await expect(page.getByText('Daily Viber')).toBeHidden();
  await page.getByPlaceholder('Search name or handle').fill('');
  await page.getByRole('button', { name: 'More actions for Studio Notes' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Disconnect Studio Notes?');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('accounts-disconnect.png'), fullPage: true });
});

test('uses the mobile navigation drawer', async ({ page }) => {
  await establishWorkspaceSession(page);
  await mockConnectedAccounts(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/w/atlas/accounts');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByLabel('Primary navigation')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create post' })).toBeVisible();
});

test('renders queue, composer, calendar modes, and safe job recovery', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await mockConnectedAccounts(page);
  let detailState = 'failed';
  let retryHeaders: Record<string, string> | null = null;
  let retryAttempts = 0;
  let cancelHeaders: Record<string, string> | null = null;
  let cancelAttempts = 0;
  let createPayload: Record<string, unknown> | null = null;
  let createHeaders: Record<string, string> | null = null;
  let firstCreateHeaders: Record<string, string> | null = null;
  let createAttempts = 0;
  await page.route('**/api/workflow/posts', async (route) => {
    createAttempts += 1;
    createPayload = route.request().postDataJSON() as Record<string, unknown>;
    createHeaders = route.request().headers();
    if (createAttempts === 1) {
      firstCreateHeaders = createHeaders;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: 'Response was interrupted. Retry safely.' }),
      });
    }
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: 'post-new', jobIds: ['one', 'two'] }, error: null }),
    });
  });
  const collisionQueryUrls: string[] = [];
  await page.route('**/api/workflow/jobs?*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('states') === 'scheduled') {
      collisionQueryUrls.push(url.toString());
      const accountId = url.searchParams.get('providerAccountId');
      const isFirstAccount = accountId === '00000000-0000-4000-8000-000000000201';
      const isSecondPage = url.searchParams.has('beforeId');
      const items = isFirstAccount
        ? [
            {
              id: isSecondPage
                ? '00000000-0000-4000-8000-000000000402'
                : '00000000-0000-4000-8000-000000000401',
              state: 'scheduled',
              scheduledAt: isSecondPage ? '2026-09-01T09:50:00+03:00' : '2026-09-01T09:40:00+03:00',
              contentPreview: 'Nearby publication',
              providerAccount: {
                id: accountId,
                displayName: 'Daily Viber',
                handle: 'dailyviber',
                provider: 'x',
              },
            },
            ...(isSecondPage
              ? [
                  {
                    id: '00000000-0000-4000-8000-000000000403',
                    state: 'scheduled',
                    scheduledAt: '2026-09-01T10:20:00+03:00',
                    contentPreview: 'Exact boundary publication',
                    providerAccount: {
                      id: accountId,
                      displayName: 'Daily Viber',
                      handle: 'dailyviber',
                      provider: 'x',
                    },
                  },
                ]
              : []),
          ]
        : [];
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            items,
            next:
              isFirstAccount && !isSecondPage
                ? {
                    beforeScheduledAt: '2026-09-01T09:40:00+03:00',
                    beforeId: '00000000-0000-4000-8000-000000000401',
                  }
                : null,
          },
          error: null,
        }),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: [
            {
              id: 'job-2048',
              state: 'failed',
              scheduledAt: '2026-09-01T09:30:00+03:00',
              contentPreview: 'The clearest plans leave room for the unexpected.',
              providerAccount: {
                id: '00000000-0000-4000-8000-000000000201',
                displayName: 'Daily Viber',
                handle: 'dailyviber',
                provider: 'x',
              },
            },
          ],
        },
        error: null,
      }),
    });
  });
  await page.route('**/api/workflow/jobs/job-2048/retry', async (route) => {
    retryAttempts += 1;
    retryHeaders = route.request().headers();
    if (retryAttempts === 1)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: 'Retry service unavailable' }),
      });
    await new Promise((resolve) => setTimeout(resolve, 200));
    detailState = 'retry_wait';
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { state: detailState }, error: null }),
    });
  });
  await page.route('**/api/workflow/jobs/job-2048/cancel', async (route) => {
    cancelAttempts += 1;
    cancelHeaders = route.request().headers();
    if (cancelAttempts === 1)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: 'Cancel service unavailable' }),
      });
    detailState = 'cancelled';
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { state: 'cancelled' }, error: null }),
    });
  });
  await page.route('**/api/workflow/jobs/job-2048', (route) => {
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 'job-2048',
          postId: 'post-2048',
          state: detailState,
          scheduledAt: '2026-09-01T09:30:00+03:00',
          content: { type: 'text', text: 'The clearest plans leave room for the unexpected.' },
          providerAccount: {
            displayName: 'Daily Viber',
            handle: 'dailyviber',
            provider: 'x',
          },
        },
        error: null,
      }),
    });
  });
  await page.goto('/w/atlas/queue');
  await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();
  await expect(page.getByText('The clearest plans')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('queue-populated.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await expect(page.getByRole('dialog', { name: 'Create post' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('composer.png'), fullPage: true });
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByText('Choose files', { exact: true }).click();
  await fileChooserPromise;
  await expect(page.getByRole('button', { name: 'Schedule 2 posts' })).toBeDisabled();
  await page.getByLabel('Post body').fill('A clear publishing update for two accounts.');
  const scheduleInput = page.getByLabel('Date and time');
  await scheduleInput.fill('2026-09-01T09:30');
  await expect(page.getByText('1 nearby publication detected')).toBeVisible();
  await page.getByRole('button', { name: 'Use next 15-minute opening' }).click();
  await expect(scheduleInput).toHaveValue('2026-09-01T10:05');
  expect(collisionQueryUrls.some((url) => url.includes('states=scheduled'))).toBe(true);
  expect(collisionQueryUrls.some((url) => url.includes('beforeId='))).toBe(true);
  expect(
    collisionQueryUrls.every((url) => {
      const query = new URL(url).searchParams;
      return query.has('scheduledAfter') && query.has('scheduledBefore');
    }),
  ).toBe(true);
  expect(
    new Set(collisionQueryUrls.map((url) => new URL(url).searchParams.get('providerAccountId'))),
  ).toEqual(
    new Set(['00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000203']),
  );
  await scheduleInput.fill('2020-01-01T09:00');
  await expect(page.getByRole('alert')).toContainText('future publishing time');
  await expect(page.getByRole('button', { name: 'Schedule 2 posts' })).toBeDisabled();
  await scheduleInput.fill('2026-09-01T10:05');
  await expect(page.getByRole('button', { name: 'Schedule 2 posts' })).toBeEnabled();
  await page.getByRole('button', { name: 'Schedule 2 posts' }).click();
  await expect(page.getByRole('alert')).toContainText('Retry safely');
  await page.getByRole('button', { name: 'Schedule 2 posts' }).click();
  await expect(page.getByRole('heading', { name: '2 posts scheduled' })).toBeVisible();
  expect(createHeaders?.['x-csrf-token']).toBeTruthy();
  expect(createHeaders?.['idempotency-key']).toBeTruthy();
  expect(createHeaders?.['idempotency-key']).toBe(firstCreateHeaders?.['idempotency-key']);
  expect(createPayload).toMatchObject({
    content: { type: 'text', text: 'A clear publishing update for two accounts.' },
    providerAccountIds: [
      '00000000-0000-4000-8000-000000000201',
      '00000000-0000-4000-8000-000000000203',
    ],
  });
  expect(new Date(String((createPayload as Record<string, unknown> | null)?.scheduledAt))).toEqual(
    new Date('2026-09-01T10:05:00+03:00'),
  );
  await page.getByRole('button', { name: 'Close composer' }).click();
  await page.goto('/w/atlas/calendar');
  for (const mode of ['Month', 'Week', 'Day', 'Timeline']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await expect(page.getByLabel(`${mode} calendar`)).toBeVisible();
    if (mode === 'Day') {
      await expect(page.getByLabel('Day calendar').getByText('Daily Viber')).toBeVisible();
    }
    await page.screenshot({
      path: testInfo.outputPath(`calendar-${mode.toLowerCase()}.png`),
      fullPage: true,
    });
  }
  await page.goto('/w/atlas/jobs/job-2048');
  await expect(page.getByRole('heading', { name: 'Daily Viber' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('job-detail-failed.png'), fullPage: true });
  await page.getByRole('button', { name: 'Retry now' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('preventing a duplicate post');
  await expect(page.getByRole('button', { name: 'Keep job' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('job-retry-confirm.png'), fullPage: true });
  await page.getByRole('button', { name: 'Retry safely' }).click();
  await expect(page.getByText('Retry service unavailable', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry now' }).click();
  await page.getByRole('button', { name: 'Retry safely' }).click();
  await expect(page.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
  await expect(page.getByText('Retry queued')).toBeVisible();
  expect(retryHeaders?.['x-csrf-token']).toBeTruthy();
  expect(retryHeaders?.['idempotency-key']).toBeTruthy();
  await page.reload();
  await expect(page.getByText('Retry queued')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel job' }).click();
  await expect(page.getByRole('button', { name: 'Keep job' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('job-cancel-confirm.png'), fullPage: true });
  await page.getByRole('button', { name: 'Cancel job', exact: true }).last().click();
  await expect(page.getByText('Cancel service unavailable', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel job' }).click();
  await page.getByRole('button', { name: 'Cancel job', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
  expect(cancelHeaders?.['x-csrf-token']).toBeTruthy();
  expect(cancelHeaders?.['idempotency-key']).toBeTruthy();
  await page.reload();
  await expect(page.locator('.job-status.cancelled')).toContainText('Cancelled');
});

test('reports collision guidance as unavailable instead of an empty result', async ({ page }) => {
  await establishWorkspaceSession(page);
  await mockConnectedAccounts(page);
  await page.route('**/api/workflow/jobs?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: 'Queue unavailable' }),
    }),
  );
  await page.goto('/w/atlas/queue');
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await expect(page.getByText('Nearby schedule guidance is unavailable.')).toBeVisible();
});

test('renders truthful queue loading, live states, empty, filtered-empty, and error states', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/workflow/jobs?limit=100', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: [
            {
              id: 'dispatching-job',
              state: 'dispatching',
              scheduledAt: '2026-09-01T09:30:00+03:00',
              contentPreview: 'Dispatching now',
              providerAccount: { displayName: 'Daily Viber', handle: 'dailyviber', provider: 'x' },
            },
            {
              id: 'retry-job',
              state: 'retry_wait',
              scheduledAt: '2026-09-01T10:30:00+03:00',
              contentPreview: 'Waiting to retry',
              providerAccount: { displayName: 'Daily Viber', handle: 'dailyviber', provider: 'x' },
            },
          ],
        },
        error: null,
      }),
    });
  });
  await page.goto('/w/atlas/queue');
  await expect(page.getByRole('status')).toContainText('Loading publication queue');
  await page.screenshot({ path: testInfo.outputPath('queue-loading.png'), fullPage: true });
  await expect(page.getByRole('link', { name: /^Dispatching / })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Retrying / })).toBeVisible();
  await page.getByPlaceholder('Search posts or accounts').fill('no-match');
  await expect(page.getByText('No jobs match these filters')).toBeVisible();

  await page.unroute('**/api/workflow/jobs?limit=100');
  await page.route('**/api/workflow/jobs?limit=100', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"data":{"items":[]},"error":null}' }),
  );
  await page.reload();
  await expect(page.getByText('Nothing scheduled yet')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('queue-empty.png'), fullPage: true });

  await page.unroute('**/api/workflow/jobs?limit=100');
  await page.route('**/api/workflow/jobs?limit=100', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"data":null,"error":"Queue offline"}',
    }),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Queue offline');
  await page.screenshot({ path: testInfo.outputPath('queue-error.png'), fullPage: true });
});

test('projects live calendar jobs by date, time, account lane, and active workspace', async ({
  page,
}) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/workflow/jobs?limit=100', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: [
            {
              id: 'mira-morning',
              state: 'dispatching',
              scheduledAt: '2026-09-01T09:15:00+03:00',
              contentPreview: 'Morning dispatch',
              providerAccount: { displayName: 'Mira Editorial', handle: 'mira', provider: 'x' },
            },
            {
              id: 'mira-lunch',
              state: 'retry_wait',
              scheduledAt: '2026-09-01T09:30:00+03:00',
              contentPreview: 'Lunch retry',
              providerAccount: { displayName: 'Mira Editorial', handle: 'mira', provider: 'x' },
            },
            {
              id: 'studio-next-day',
              state: 'failed',
              scheduledAt: '2026-09-02T10:45:00+03:00',
              contentPreview: 'Next day failure',
              providerAccount: { displayName: 'Studio Notes', handle: 'studio', provider: 'x' },
            },
            {
              id: 'studio-weekend',
              state: 'scheduled',
              scheduledAt: '2026-09-06T11:00:00+03:00',
              contentPreview: 'Sunday publication',
              providerAccount: { displayName: 'Studio Notes', handle: 'studio', provider: 'x' },
            },
          ],
        },
        error: null,
      }),
    });
  });
  await page.goto('/w/mira-studio/calendar');
  await expect(page.getByRole('status')).toContainText('Loading publication calendar');
  await expect(page.getByRole('button', { name: '2 accounts' })).toBeVisible();

  await page.getByRole('button', { name: 'Month', exact: true }).click();
  const septemberFirst = page.getByRole('gridcell', { name: /Tuesday, September 1, 2026/ });
  const septemberSecond = page.getByRole('gridcell', { name: /Wednesday, September 2, 2026/ });
  await expect(septemberFirst.getByRole('link')).toHaveCount(2);
  await expect(septemberSecond.getByRole('link')).toHaveCount(1);
  await expect(septemberFirst.getByRole('link').first()).toHaveAttribute(
    'href',
    '/w/mira-studio/jobs/mira-morning',
  );

  await page.getByRole('button', { name: 'Week', exact: true }).click();
  const morning = page.getByRole('link', { name: /Mira Editorial, Dispatching/ });
  const lunch = page.getByRole('link', { name: /Mira Editorial, Retrying/ });
  await expect(morning).toHaveAttribute('style', /top: 53\.75px/);
  await expect(lunch).toHaveAttribute('style', /top: 64\.5px/);
  await expect(page.getByRole('link', { name: /Studio Notes, Failed/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Studio Notes, Scheduled/ })).toBeVisible();

  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await expect(page.getByLabel('Day calendar').getByRole('link')).toHaveCount(2);

  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(page.locator('.timeline-lane')).toHaveCount(1);
  await expect(page.locator('.timeline-lane').getByRole('link')).toHaveCount(2);
  await expect(page.locator('.timeline-lane').getByRole('link').first()).toHaveAttribute(
    'style',
    /grid-area: 1 \/ 3 \/ auto \/ span 2/,
  );
  await expect(page.locator('.timeline-lane').getByRole('link').nth(1)).toHaveAttribute(
    'style',
    /grid-area: 2 \/ 4 \/ auto \/ span 2/,
  );
  await expect(page.locator('.timeline-lane').getByRole('link').first()).toHaveAttribute(
    'href',
    '/w/mira-studio/jobs/mira-morning',
  );

  await page.unroute('**/api/workflow/jobs?limit=100');
  await page.route('**/api/workflow/jobs?limit=100', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"data":{"items":[]},"error":null}' }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: '0 accounts' })).toBeVisible();
  await expect(page.locator('.time-calendar')).toBeVisible();

  await page.unroute('**/api/workflow/jobs?limit=100');
  await page.route('**/api/workflow/jobs?limit=100', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"data":null,"error":"Calendar offline"}',
    }),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Calendar offline');
});

test('renders truthful job-detail loading, alternate state, workspace routing, and errors', async ({
  page,
}) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/workflow/jobs/pending-job', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 'pending-job',
          postId: 'pending-post',
          state: 'accepted_pending',
          scheduledAt: '2026-09-01T09:30:00+03:00',
          content: { type: 'text', text: 'Waiting for provider confirmation.' },
          providerAccount: {
            displayName: 'Mira Editorial',
            handle: 'miraeditorial',
            provider: 'x',
          },
        },
        error: null,
      }),
    });
  });
  await page.goto('/w/mira-studio/jobs/pending-job');
  await expect(page.getByRole('status')).toContainText('Loading publication job');
  await expect(page.getByRole('heading', { name: 'Mira Editorial' })).toBeVisible();
  await expect(page.getByText('Provider processing')).toBeVisible();
  await expect(page.getByText('Waiting for provider confirmation.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Back to queue/ })).toHaveAttribute(
    'href',
    '/w/mira-studio/queue',
  );
  await expect(page.getByRole('button', { name: 'Retry now' })).toBeHidden();

  await page.unroute('**/api/workflow/jobs/pending-job');
  await page.route('**/api/workflow/jobs/pending-job', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{"data":null,"error":"Job missing"}',
    }),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Job missing');
  await expect(page.getByRole('link', { name: 'Back to queue' })).toHaveAttribute(
    'href',
    '/w/mira-studio/queue',
  );
});

test('edits a scheduled job through the canonical browser revision route', async ({ page }) => {
  await establishWorkspaceSession(page);
  let revisionPayload: Record<string, unknown> | null = null;
  const revisionKeys: string[] = [];
  await page.route('**/api/workflow/jobs/scheduled-job', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 'scheduled-job',
          postId: 'scheduled-post',
          state: 'scheduled',
          scheduledAt: '2027-09-01T09:30:00+03:00',
          content: { type: 'text', text: 'Move this publication safely.' },
          providerAccount: {
            id: '00000000-0000-4000-8000-000000000201',
            displayName: 'Daily Viber',
            handle: 'dailyviber',
            provider: 'x',
          },
        },
        error: null,
      }),
    }),
  );
  await page.route('**/api/workflow/posts/scheduled-post/schedule', async (route) => {
    revisionPayload = route.request().postDataJSON() as Record<string, unknown>;
    revisionKeys.push(route.request().headers()['idempotency-key'] ?? '');
    if (revisionKeys.length === 1)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: 'Revision response interrupted' }),
      });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { revisionId: 'revision-new' }, error: null }),
    });
  });
  await page.goto('/w/atlas/jobs/scheduled-job');
  await page.getByRole('button', { name: 'Edit schedule' }).click();
  await page.getByLabel('Date and time').fill('2027-09-02T10:15');
  await page.getByRole('button', { name: 'Update schedule' }).click();
  await expect(page.getByRole('alert')).toContainText('Revision response interrupted');
  await page.getByRole('button', { name: 'Update schedule' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit publishing time' })).toBeHidden();
  expect(revisionKeys).toHaveLength(2);
  expect(revisionKeys[1]).toBe(revisionKeys[0]);
  expect(revisionPayload).toMatchObject({
    scheduledAt: expect.any(String),
  });
  expect(
    new Date(String((revisionPayload as Record<string, unknown> | null)?.scheduledAt)).getDate(),
  ).toBe(2);
});

test.describe('Europe/Sofia DST scheduling', () => {
  test.use({ timezoneId: 'Europe/Sofia' });

  test('blocks spring gaps and persists both autumn-fold offsets', async ({ page }) => {
    await establishWorkspaceSession(page);
    await mockConnectedAccounts(page);
    const persistedSchedules: string[] = [];
    await page.route('**/api/workflow/jobs?limit=100', (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"data":{"items":[]}}' }),
    );
    await page.route('**/api/workflow/posts', async (route) => {
      const payload = route.request().postDataJSON() as { scheduledAt: string };
      persistedSchedules.push(payload.scheduledAt);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: '{"data":{"id":"post-dst","jobIds":["one","two"]},"error":null}',
      });
    });
    await page.goto('/w/atlas/queue');

    const scheduleFold = async (offsetLabel: string) => {
      await page.getByRole('button', { name: 'Create post' }).last().click();
      await page.getByLabel('Post body').fill(`DST choice ${offsetLabel}`);
      await page.getByLabel('Date and time').fill('2027-03-28T03:30');
      await expect(page.getByRole('alert')).toContainText('clock changes');
      await expect(page.getByRole('button', { name: 'Schedule 2 posts' })).toBeDisabled();
      await page.getByLabel('Date and time').fill('2027-10-31T03:30');
      await expect(page.getByText('This time occurs twice')).toBeVisible();
      await page.getByRole('radio', { name: offsetLabel, exact: true }).check();
      await page.getByRole('button', { name: 'Schedule 2 posts' }).click();
      await expect(page.getByRole('heading', { name: '2 posts scheduled' })).toBeVisible();
      await page.getByRole('button', { name: 'Close composer' }).click();
    };

    await scheduleFold('UTC+03:00');
    await scheduleFold('UTC+02:00');
    expect(persistedSchedules).toEqual(['2027-10-31T00:30:00.000Z', '2027-10-31T01:30:00.000Z']);
  });
});
