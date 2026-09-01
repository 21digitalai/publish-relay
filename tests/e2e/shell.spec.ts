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

test('renders the login surface and reports an inline authentication error', async ({ page }) => {
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

test('filters accounts and opens a named disconnect confirmation', async ({ page }) => {
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
  await page.route('**/api/workflow/jobs?limit=100', (route) =>
    route.fulfill({
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
                displayName: 'Daily Viber',
                handle: 'dailyviber',
                provider: 'x',
              },
            },
          ],
        },
        error: null,
      }),
    }),
  );
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
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await expect(page.getByRole('dialog', { name: 'Create post' })).toBeVisible();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByText('Choose files', { exact: true }).click();
  await fileChooserPromise;
  await expect(page.getByRole('button', { name: 'Schedule 2 posts' })).toBeDisabled();
  await page.getByLabel('Post body').fill('A clear publishing update for two accounts.');
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
  await page.getByRole('button', { name: 'Close composer' }).click();
  await page.goto('/w/atlas/calendar');
  for (const mode of ['Month', 'Week', 'Day', 'Timeline']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await expect(page.getByLabel(`${mode} calendar`)).toBeVisible();
    if (mode === 'Day') {
      await expect(page.getByLabel('Day calendar').getByText('Daily Viber')).toBeVisible();
    }
  }
  await page.screenshot({ path: testInfo.outputPath('calendar-timeline.png'), fullPage: true });
  await page.goto('/w/atlas/jobs/job-2048');
  await expect(page.getByRole('heading', { name: 'Daily Viber' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry now' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('preventing a duplicate post');
  await expect(page.getByRole('button', { name: 'Keep job' })).toBeFocused();
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
});

test('renders truthful queue loading, live states, empty, filtered-empty, and error states', async ({
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
