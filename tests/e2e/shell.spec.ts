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

async function workspacePath(page: Page, path: string) {
  const response = await page.request.get('/api/workspaces/current');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { data: { slug: string } };
  return `/w/${body.data.slug}/${path}`;
}

test('renders persisted shell identity on desktop and mobile after reload', async ({ page }) => {
  const suffix = Math.random().toString(36).slice(2);
  const displayName = `Nova Operator ${suffix}`;
  const email = `nova-${suffix}@example.test`;
  const workspaceName = `Nebula Desk ${suffix}`;
  const response = await page.request.post('/api/auth/register', {
    data: { displayName, email, password: 'long-password-123!', workspaceName },
  });
  expect(response.ok()).toBe(true);
  await page.goto('/w/nebula/accounts');
  await expect(page.getByRole('button', { name: new RegExp(displayName) })).toContainText(email);
  await expect(
    page.getByText(`Manage publishing access and connection health for ${workspaceName}.`),
  ).toBeVisible();
  await expect(page.getByText('All systems operational')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(displayName) })).toContainText(email);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('button', { name: new RegExp(displayName) })).toContainText(email);
});

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
              adapterDefaults: {},
            },
            {
              id: '00000000-0000-4000-8000-000000000202',
              provider: 'x',
              displayName: 'Studio Notes (@studionotes)',
              status: 'reconnect_required',
              updatedAt: '2026-08-29T00:00:00Z',
              adapterDefaults: {},
            },
            {
              id: '00000000-0000-4000-8000-000000000203',
              provider: 'instagram',
              displayName: 'Mira Studio (@mirastudio)',
              status: 'active',
              updatedAt: '2026-09-01T00:00:00Z',
              adapterDefaults: {},
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

test('hydrates an imported draft in the canonical composer on desktop and mobile', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await mockConnectedAccounts(page);
  const draftId = '00000000-0000-4000-8000-000000000850';
  await page.route(`**/api/workflow/drafts/${draftId}`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: draftId,
          label: 'Approved launch clip',
          mediaIds: ['00000000-0000-4000-8000-000000000851'],
          postId: null,
        },
        error: null,
      }),
    }),
  );
  await page.route('**/api/workflow/jobs?**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [], next: null }, error: null }),
    }),
  );
  const path = await workspacePath(page, `drafts/${draftId}`);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Create post' })).toBeVisible();
  await expect(page.getByText('Approved launch clip')).toBeVisible();
  await expect(page.getByText('1 attached media item ready')).toBeVisible();
  await expect(page.locator('.composer-sheet')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('external-draft-desktop.png'),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.composer-sheet')).toBeVisible();
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
  await page.screenshot({ path: testInfo.outputPath('external-draft-mobile.png'), fullPage: true });
});

test('keeps imported-draft scheduling disabled until hydration succeeds and after failure', async ({
  page,
}) => {
  await establishWorkspaceSession(page);
  await mockConnectedAccounts(page);
  await page.route('**/api/workflow/jobs?**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [], next: null }, error: null }),
    }),
  );
  const draftId = '00000000-0000-4000-8000-000000000860';
  let releaseDraft: (() => void) | undefined;
  const draftGate = new Promise<void>((resolve) => {
    releaseDraft = resolve;
  });
  await page.route(`**/api/workflow/drafts/${draftId}`, async (route) => {
    await draftGate;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: draftId,
          label: 'Delayed clip',
          mediaIds: ['00000000-0000-4000-8000-000000000861'],
          postId: null,
        },
        error: null,
      }),
    });
  });
  const path = await workspacePath(page, `drafts/${draftId}`);
  await page.goto(path);
  await page.getByLabel('Post body').fill('Ready only after hydration');
  const schedule = page.getByRole('button', { name: 'Schedule 2 posts' });
  await expect(schedule).toBeDisabled();
  releaseDraft?.();
  await expect(page.getByText('1 attached media item ready')).toBeVisible();
  await expect(schedule).toBeEnabled();

  let postRequests = 0;
  await page.route('**/api/workflow/posts', (route) => {
    postRequests += 1;
    return route.abort();
  });
  await page.route(`**/api/workflow/drafts/${draftId}`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: 'Draft not found' }),
    }),
  );
  await page.reload();
  await page.getByLabel('Post body').fill('Must remain blocked');
  await expect(page.getByRole('alert')).toContainText('Draft not found');
  await expect(schedule).toBeDisabled();
  expect(postRequests).toBe(0);
});

test('approves the registered Open Clips loopback client and exposes revocation', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await page.route('http://127.0.0.1:43123/callback**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Open Clips connected</h1>' }),
  );
  await page.route('**/connect/authorize', async (route) => {
    if (route.request().method() === 'GET') return route.continue();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          authorizationRedirect:
            'http://127.0.0.1:43123/callback?code=opaque-code&state=open-clips-state',
        },
        error: null,
      }),
    });
  });
  await page.route('**/api/settings/delegated-grants**', async (route) => {
    if (route.request().method() === 'DELETE')
      return route.fulfill({
        contentType: 'application/json',
        body: '{"data":{"revoked":true},"error":null}',
      });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: 'grant-1',
            clientId: 'open-clips-dev',
            scopes: ['destinations:read', 'schedules:write'],
            createdAt: '2026-09-10T10:00:00.000Z',
          },
        ],
        error: null,
      }),
    });
  });
  const query = new URLSearchParams({
    client_id: 'open-clips-dev',
    redirect_uri: 'http://127.0.0.1:43123/callback',
    state: 'open-clips-state',
    code_challenge: 'c'.repeat(43),
    code_challenge_method: 'S256',
    scope: 'destinations:read schedules:read schedules:write content:write publishes:retry',
  });
  await page.goto(`/connect/authorize?${query}`);
  await expect(page.getByRole('heading', { name: 'Approve access' })).toBeVisible();
  await expect(page.getByText('open-clips-dev', { exact: true })).toBeVisible();
  await expect(page.getByText('publishes:retry', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Approve access' })).toBeVisible();
  await expect(page.getByText('open-clips-dev', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('open-clips-consent.png'), fullPage: true });
  await page.getByRole('button', { name: 'Approve connection' }).click();
  await page.waitForURL(
    (url) =>
      url.origin === 'http://127.0.0.1:43123' &&
      url.pathname === '/callback' &&
      url.searchParams.has('code') &&
      url.searchParams.get('state') === 'open-clips-state',
  );
  expect([...new URL(page.url()).searchParams.keys()].sort()).toEqual(['code', 'state']);
  await page.goto(await workspacePath(page, 'settings/integrations'));
  await expect(page.getByText('open-clips-dev', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke connection' }).click();
  await page.getByRole('button', { name: 'Confirm revoke' }).click();
  await expect(page.getByText('No applications connected.')).toBeVisible();
  await page.goto(`/connect/authorize?${query}`);
  await expect(page.getByRole('heading', { name: 'Approve access' })).toBeVisible();
  await expect(page.getByText('publishes:retry', { exact: true })).toBeVisible();
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
  await page.goto(await workspacePath(page, 'accounts'));
  await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible();
  await expect(page.getByText('Studio Notes')).toBeVisible();
  await page.getByPlaceholder('Search name or handle').fill('Mira');
  await expect(page.getByText('Mira Studio')).toBeVisible();
  await expect(page.getByText('Daily Viber', { exact: true })).toBeHidden();
  await page.getByPlaceholder('Search name or handle').fill('');
  await page.getByRole('button', { name: 'More actions for Studio Notes' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Disconnect Studio Notes?');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('accounts-disconnect.png'), fullPage: true });
});

test('edits YouTube destination defaults through the account row', async ({ page }) => {
  await establishWorkspaceSession(page);
  let savedBody: unknown;
  let savedHeaders: Record<string, string> = {};
  let savedMethod = '';
  let patchCount = 0;
  let persistedDefaults: {
    privacyStatus: string;
    madeForKids: boolean;
    notifySubscribers?: boolean;
    tags?: string[];
    categoryId?: string;
  } = { privacyStatus: 'unlisted', madeForKids: false };
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: '00000000-0000-4000-8000-000000000204',
              provider: 'youtube',
              displayName: 'Relay Channel',
              status: 'active',
              updatedAt: '2026-09-01T00:00:00Z',
              adapterDefaults: persistedDefaults,
            },
          ],
        },
        error: null,
      }),
    }),
  );
  await page.route('**/api/provider-accounts/*/youtube-defaults', async (route) => {
    patchCount += 1;
    savedBody = route.request().postDataJSON();
    savedHeaders = route.request().headers();
    savedMethod = route.request().method();
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (patchCount === 2) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: 'Defaults service is unavailable' }),
      });
      return;
    }
    persistedDefaults = savedBody as typeof persistedDefaults;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { adapterDefaults: savedBody }, error: null }),
    });
  });
  await page.goto(await workspacePath(page, 'accounts'));
  await expect(page.getByRole('button', { name: /Connect X/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Connect YouTube/ })).toBeVisible();
  await expect(page.getByText('Publishing defaults')).toBeVisible();
  await page.getByRole('button', { name: 'Visibility' }).click();
  await expect(page.getByRole('listbox', { name: 'Visibility' })).toBeInViewport();
  await page.getByRole('option', { name: 'Public' }).click();
  await page.getByRole('button', { name: 'Made for kids' }).click();
  await page.getByRole('option', { name: 'Yes' }).click();
  await page.getByRole('switch', { name: 'Notify subscribers' }).click();
  await page.getByLabel('Tags (optional)').fill('launch, tutorial');
  await page.getByRole('button', { name: 'Category (optional)' }).click();
  await expect(page.getByRole('listbox', { name: 'Category (optional)' })).toBeInViewport();
  await page.getByRole('option', { name: 'People & Blogs' }).click();
  const saveButton = page.getByRole('button', { name: 'Save defaults' });
  await saveButton.click();
  await expect
    .poll(() => savedBody)
    .toEqual({
      privacyStatus: 'public',
      madeForKids: true,
      notifySubscribers: true,
      tags: ['launch', 'tutorial'],
      categoryId: '22',
    });
  expect(savedMethod).toBe('PATCH');
  expect(savedHeaders['x-csrf-token']).toBeTruthy();
  await expect(page.getByRole('status')).toContainText(
    'Publishing defaults saved for Relay Channel.',
  );
  await expect(saveButton).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Visibility' })).toContainText('Public');
  await expect(page.getByRole('button', { name: 'Made for kids' })).toContainText('Yes');
  await expect(page.getByRole('switch', { name: 'Notify subscribers' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByLabel('Tags (optional)')).toHaveValue('launch, tutorial');
  await expect(page.getByRole('button', { name: 'Category (optional)' })).toContainText(
    'People & Blogs',
  );
  await page.getByRole('button', { name: 'Made for kids' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('listbox', { name: 'Made for kids' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'No' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Yes' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Made for kids' })).toContainText('Yes');
  await expect(page.getByRole('button', { name: 'Made for kids' })).toBeFocused();
  await page.getByRole('button', { name: 'Visibility' }).click();
  await page.getByRole('option', { name: 'Private' }).click();
  await page.getByLabel('Tags (optional)').fill('');
  await page.getByRole('button', { name: 'Category (optional)' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'No category' })).toBeFocused();
  await expect(page.getByRole('listbox', { name: 'Category (optional)' })).toBeInViewport();
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: 'Nonprofits & Activism' })).toBeFocused();
  await expect(page.getByRole('option', { name: 'Nonprofits & Activism' })).toBeInViewport();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Category (optional)' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'No category' })).toBeFocused();
  await page.keyboard.press(' ');
  await page.getByRole('button', { name: 'Save defaults' }).click();
  await expect(page.getByRole('alert')).toContainText('Defaults service is unavailable');
  expect(savedBody).not.toHaveProperty('tags');
  expect(savedBody).not.toHaveProperty('categoryId');
});

test('persists credential-free fake-provider connect and disconnect through reload', async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-09-01T05:00:00.000Z'));
  await establishWorkspaceSession(page);
  await page.goto(await workspacePath(page, 'accounts?state=empty'));
  await expect(page.getByRole('heading', { name: 'Connect your first account' })).toBeVisible();
  await expect(page.getByLabel('Account health summary')).toContainText(
    '0Connected accounts0Healthy0Needs attention',
  );
  await page.screenshot({ path: testInfo.outputPath('accounts-empty.png'), fullPage: true });
  await page.goto(await workspacePath(page, 'accounts?state=loading'));
  await expect(page.getByLabel('Loading accounts')).toBeVisible();
  await expect(page.getByLabel('Loading account health')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('accounts-loading.png'), fullPage: true });
  await page.goto(await workspacePath(page, 'accounts?state=error'));
  await expect(page.getByRole('alert')).toContainText('Accounts could not be loaded');
  await expect(page.getByLabel('Account health summary')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('accounts-error.png'), fullPage: true });
  await page.goto(await workspacePath(page, 'accounts'));
  await page.getByRole('button', { name: 'Connect X', exact: true }).click();
  await expect(page.getByText('Daily Viber')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Daily Viber')).toBeVisible();
  await expect(page.getByText('Studio Notes')).toBeVisible();
  await expect(page.getByLabel('Account health summary')).toContainText(
    '2Connected accounts2Healthy0Needs attention',
  );
  await page.screenshot({ path: testInfo.outputPath('accounts-populated.png'), fullPage: true });
  expect((await page.request.post('/__test__/provider-reconnect-required')).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reconnect' }).first()).toBeVisible();
  await expect(page.getByLabel('Account health summary')).toContainText(
    '2Connected accounts0Healthy2Needs attention',
  );
  await page.screenshot({ path: testInfo.outputPath('accounts-reconnect.png'), fullPage: true });
  await page.getByRole('button', { name: 'Reconnect' }).first().click();
  await expect(page.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
  expect((await page.request.post('/__test__/block-account-disconnect')).ok()).toBe(true);
  await page.getByRole('button', { name: 'More actions for Daily Viber' }).click();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.getByRole('button', { name: 'Disconnect account' }).click();
  await expect(page.getByRole('alert')).toContainText('Cancel scheduled jobs');
  await expect(page.getByText('Daily Viber', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Account health summary')).toContainText(
    '2Connected accounts2Healthy0Needs attention',
  );
  await page.screenshot({
    path: testInfo.outputPath('accounts-disconnect-blocked.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'More actions for Studio Notes' }).click();
  await page.getByRole('button', { name: 'Disconnect account' }).click();
  await expect(page.getByText('Studio Notes', { exact: true })).toBeHidden();
  await expect(page.getByLabel('Account health summary')).toContainText(
    '1Connected accounts1Healthy0Needs attention',
  );
  await page.reload();
  await expect(page.getByText('Daily Viber', { exact: true })).toBeVisible();
  await expect(page.getByText('Studio Notes', { exact: true })).toBeHidden();
  await page.screenshot({
    path: testInfo.outputPath('accounts-disconnect-success.png'),
    fullPage: true,
  });
});

test('uses the mobile navigation drawer', async ({ page }) => {
  await establishWorkspaceSession(page);
  await mockConnectedAccounts(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(await workspacePath(page, 'accounts'));
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByLabel('Primary navigation')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create post' })).toBeVisible();
});

test('operates the workspace switcher completely from the keyboard', async ({ page }) => {
  await establishWorkspaceSession(page);
  await mockConnectedAccounts(page);
  let switchedTo = '';
  let activeShellWorkspace = {
    id: '00000000-0000-4000-8000-000000000401',
    slug: 'atlas',
    name: 'Atlas',
  };
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          user: { displayName: 'Switch Operator', email: 'switch@example.test' },
          workspace: {
            ...activeShellWorkspace,
            role: activeShellWorkspace.slug === 'atlas' ? 'owner' : 'editor',
          },
        },
        error: null,
      }),
    }),
  );
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          workspaces: [
            {
              id: '00000000-0000-4000-8000-000000000401',
              slug: 'atlas',
              name: 'Atlas',
              role: 'owner',
            },
            {
              id: '00000000-0000-4000-8000-000000000402',
              slug: 'relay',
              name: 'Relay',
              role: 'editor',
            },
          ],
        },
        error: null,
      }),
    }),
  );
  await page.route('**/api/workspaces/*/switch', (route) => {
    switchedTo = route.request().url();
    activeShellWorkspace = {
      id: '00000000-0000-4000-8000-000000000402',
      slug: 'relay',
      name: 'Relay',
    };
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { workspace: { slug: 'relay' } }, error: null }),
    });
  });
  await page.goto(await workspacePath(page, 'accounts'));
  if ((page.viewportSize()?.width ?? 0) < 768)
    await page.getByRole('button', { name: 'Open navigation' }).click();
  const trigger = page.getByRole('button', { name: /Atlas owner/ });
  await trigger.click();
  const search = page.getByRole('combobox', { name: 'Search workspaces' });
  await expect(search).toBeFocused();
  await search.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await search.press('End');
  await expect(search).toHaveAttribute('aria-activedescendant', /000000000402$/);
  await search.press('Enter');
  await expect(page).toHaveURL('/w/relay/accounts');
  await expect(page.getByRole('button', { name: /Switch Operator/ })).toContainText(
    'switch@example.test',
  );
  await expect(
    page.getByText('Manage publishing access and connection health for Relay.'),
  ).toBeVisible();
  expect(switchedTo).toContain('00000000-0000-4000-8000-000000000402/switch');
});

test('keeps the current session valid after a hidden invalid workspace switch', async ({
  page,
}) => {
  await establishWorkspaceSession(page);
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'publish_relay_csrf',
  )?.value;
  const response = await page.request.post(
    '/api/workspaces/00000000-0000-4000-8000-000000000499/switch',
    { headers: { 'x-csrf-token': csrf ?? '' } },
  );
  expect(response.status()).toBe(404);
  expect((await page.request.get('/api/auth/session')).ok()).toBe(true);
});

test('renders queue, composer, calendar modes, and safe job recovery', async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-09-01T05:00:00.000Z'));
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
    await new Promise((resolve) => setTimeout(resolve, 200));
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
  await page.goto(await workspacePath(page, 'queue'));
  await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();
  await expect(page.getByText('The clearest plans')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('queue-populated.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await expect(page.getByRole('dialog', { name: 'Create post' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('composer.png'), fullPage: true });
  await expect(page.getByRole('button', { name: 'Choose files' })).toBeDisabled();
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
  await page.goto(await workspacePath(page, 'calendar'));
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
  await page.goto(await workspacePath(page, 'jobs/job-2048'));
  await expect(page.getByRole('heading', { name: 'Daily Viber' })).toBeVisible();
  await expect(page.getByRole('status')).toBeEmpty();
  await page.screenshot({ path: testInfo.outputPath('job-detail-failed.png'), fullPage: true });
  await page.getByRole('button', { name: 'Retry now' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('preventing a duplicate post');
  await expect(page.getByRole('button', { name: 'Keep job' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('job-retry-confirm.png'), fullPage: true });
  await page.getByRole('button', { name: 'Retry safely' }).click();
  await expect(page.getByText('Retry service unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Retry failed: Retry service unavailable');
  await page.getByRole('button', { name: 'Retry now' }).click();
  await page.getByRole('button', { name: 'Retry safely' }).click();
  await expect(page.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Retrying publication');
  await expect(page.getByText('Retry queued', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Publication retry queued successfully');
  expect(retryHeaders?.['x-csrf-token']).toBeTruthy();
  expect(retryHeaders?.['idempotency-key']).toBeTruthy();
  await page.reload();
  await expect(page.getByText('Retry queued', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toBeEmpty();
  await page.getByRole('button', { name: 'Cancel job' }).click();
  await expect(page.getByRole('button', { name: 'Keep job' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('job-cancel-confirm.png'), fullPage: true });
  await page.getByRole('button', { name: 'Cancel job', exact: true }).last().click();
  await expect(page.getByText('Cancel service unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'Cancellation failed: Cancel service unavailable',
  );
  await page.getByRole('button', { name: 'Cancel job' }).click();
  await page.getByRole('button', { name: 'Cancel job', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Cancelling publication');
  await expect(page.getByRole('status')).toContainText('Publication cancelled successfully');
  expect(cancelHeaders?.['x-csrf-token']).toBeTruthy();
  expect(cancelHeaders?.['idempotency-key']).toBeTruthy();
  await page.reload();
  await expect(page.locator('.job-status.cancelled')).toContainText('Cancelled');
  await expect(page.getByRole('status')).toBeEmpty();
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
  await page.goto(await workspacePath(page, 'queue'));
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await expect(page.getByText('Nearby schedule guidance is unavailable.')).toBeVisible();
});

test('schedules a YouTube MP4 with safe retry cleanup and friendly settings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await establishWorkspaceSession(page);
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: '00000000-0000-4000-8000-000000000901',
              provider: 'youtube',
              displayName: 'Relay Channel',
              status: 'active',
              adapterDefaults: {},
            },
          ],
        },
        error: null,
      }),
    }),
  );
  let createCount = 0;
  await page.route('**/api/workflow/jobs?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items:
            createCount > 1
              ? [
                  {
                    id: 'job-youtube',
                    postId: 'post-youtube',
                    state: 'scheduled',
                    scheduledAt: '2026-09-09T10:00:00.000Z',
                    contentPreview: 'A finished short',
                    providerAccount: {
                      id: '00000000-0000-4000-8000-000000000901',
                      displayName: 'Relay Channel',
                      handle: 'relay-channel',
                      provider: 'youtube',
                    },
                    media: { count: 1, previewUrl: null },
                  },
                ]
              : [],
          next: null,
        },
        error: null,
      }),
    }),
  );
  let uploadCount = 0;
  const deletedMedia: string[] = [];
  await page.route('**/api/workflow/media', (route) => {
    uploadCount += 1;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: `media-${String(uploadCount)}` }, error: null }),
    });
  });
  await page.route('**/api/workflow/media/*', (route) => {
    deletedMedia.push(route.request().url());
    if (deletedMedia.length === 1)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"data":null,"error":"Cleanup unavailable"}',
      });
    return route.fulfill({
      contentType: 'application/json',
      body: '{"data":{"deleted":true},"error":null}',
    });
  });
  await page.route('**/api/workflow/posts', (route) => {
    createCount += 1;
    if (createCount === 1)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: 'Scheduling is temporarily unavailable' }),
      });
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          jobs: [
            {
              id: 'job-youtube',
              effectiveProviderSettings: {
                privacyStatus: 'public',
                madeForKids: false,
                notifySubscribers: true,
              },
            },
          ],
        },
        error: null,
      }),
    });
  });
  await page.goto(await workspacePath(page, 'queue'));
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await page.getByLabel('Video title').fill('A finished short');
  await page.getByLabel('Made for kids').click();
  await page.getByRole('option', { name: 'No', exact: true }).click();
  await page.getByLabel('Visibility').click();
  await page.getByRole('option', { name: 'Public' }).click();
  await page.getByLabel('Notify subscribers').click();
  await page.getByRole('option', { name: 'Yes', exact: true }).click();
  await page.locator('#composer-media-upload').setInputFiles({
    name: 'short.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('mp4'),
  });
  const schedule = page.getByRole('button', { name: 'Schedule 1 post' });
  await schedule.click();
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect.poll(() => deletedMedia.length).toBe(1);
  await schedule.click();
  await expect(page.getByRole('heading', { name: '1 posts scheduled' })).toBeVisible();
  const settings = page.getByLabel('YouTube settings');
  await expect(settings).toContainText('Visibilitypublic');
  await expect(settings).toContainText('Made for kidsNo');
  await expect(settings).toContainText('Notify subscribersYes');
  expect(uploadCount).toBe(1);
  expect(deletedMedia).toHaveLength(1);
  expect(deletedMedia[0]).toContain('/api/workflow/media/media-1');
  await page.getByRole('button', { name: 'Close composer' }).click();
  await page.reload();
  await expect(page.getByText('A finished short')).toBeVisible();
});

test('suppresses workflow motion when reduced motion is requested', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-01T05:00:00.000Z'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await establishWorkspaceSession(page);
  await mockConnectedAccounts(page);
  let queueRequests = 0;
  await page.route('**/api/workflow/jobs?*', async (route) => {
    queueRequests += 1;
    if (queueRequests === 1) await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [], next: null }, error: null }),
    });
  });
  await page.route('**/api/workflow/posts', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: 'post-reduced', jobIds: ['job-reduced'] }, error: null }),
    }),
  );

  await page.goto(await workspacePath(page, 'queue'));
  const loadingShape = page.locator('.loading-shape').first();
  await expect(loadingShape).toBeVisible();
  await expect(loadingShape).toHaveCSS('animation-name', 'none');
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await expect(page.locator('.composer-sheet')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.sheet-backdrop')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.composer-sheet')).toHaveCSS('transform', 'none');
  await page.getByLabel('Post body').fill('Reduced motion scheduling receipt.');
  await page.getByLabel('Date and time').fill('2026-09-01T10:05');
  await page.getByRole('button', { name: /Schedule \d+ posts?/ }).click();
  const successMark = page.locator('.composer-receipt > span');
  await expect(successMark).toBeVisible();
  await expect(successMark).toHaveCSS('animation-name', 'none');
  await expect(successMark).toHaveCSS('transform', 'none');
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
  await page.goto(await workspacePath(page, 'queue'));
  await expect(page.getByRole('status')).toContainText('Loading publication queue');
  await page.screenshot({ path: testInfo.outputPath('queue-loading.png'), fullPage: true });
  await expect(page.getByRole('link', { name: /^Dispatching / })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Retrying / })).toBeVisible();
  await page.getByLabel('Status filter').click();
  await page.getByRole('option', { name: 'Retrying' }).click();
  await expect(page.getByRole('link', { name: /^Dispatching / })).toBeHidden();
  await expect(page).toHaveURL(/status=retrying/);
  await page.getByLabel('Provider filter').click();
  await page.getByRole('option', { name: 'X', exact: true }).click();
  await page.getByLabel('Date filter').click();
  await page.getByRole('option', { name: 'Today', exact: true }).click();
  await expect(page).toHaveURL(/provider=x/);
  await expect(page).toHaveURL(/date=today/);
  await page.getByLabel('Sort order').click();
  await page.getByRole('option', { name: 'Newest first' }).click();
  await page.reload();
  await expect(page.getByLabel('Status filter')).toContainText('Retrying');
  await expect(page.getByLabel('Provider filter')).toContainText('X');
  await expect(page.getByLabel('Date filter')).toContainText('Today');
  await expect(page.getByLabel('Sort order')).toContainText('Newest first');
  await page.getByLabel('Provider filter').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Provider filter' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Provider filter' })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('queue-filtered.png'), fullPage: true });
  await page.getByRole('button', { name: 'Published', exact: true }).click();
  await expect(page.getByText('No jobs match these filters')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: 'Upcoming', exact: true }).click();
  await expect(page.getByRole('link', { name: /^Dispatching / })).toBeVisible();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByPlaceholder('Search posts or accounts').fill('no-match');
  await expect(page.getByText('No jobs match these filters')).toBeVisible();

  await page.unroute('**/api/workflow/jobs?limit=100');
  await page.route('**/api/workflow/jobs?limit=100', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"data":{"items":[]},"error":null}' }),
  );
  await page.reload();
  await expect(page).toHaveURL(/q=no-match/);
  await expect(page.getByText('No jobs match these filters')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
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
  await page.goto('/w/mira-studio/calendar?mode=Week&date=2026-09-01');
  await expect(page.getByRole('status')).toContainText('Loading publication calendar');
  await page.screenshot({ path: testInfo.outputPath('calendar-loading.png'), fullPage: true });
  await expect(page.getByRole('button', { name: '2 accounts' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('calendar-week.png'), fullPage: true });

  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(page).toHaveURL(/mode=Month&date=2026-09-01/);
  const septemberFirst = page.getByRole('gridcell', { name: /Tuesday, September 1, 2026/ });
  const septemberSecond = page.getByRole('gridcell', { name: /Wednesday, September 2, 2026/ });
  await expect(septemberFirst.getByRole('link')).toHaveCount(2);
  await expect(septemberSecond.getByRole('link')).toHaveCount(1);
  await expect(septemberFirst.getByRole('link').first()).toHaveAttribute(
    'href',
    '/w/mira-studio/jobs/mira-morning',
  );
  await page.screenshot({ path: testInfo.outputPath('calendar-month.png'), fullPage: true });
  await page.getByRole('button', { name: 'Previous date' }).click();
  await expect(page).toHaveURL(/mode=Month&date=2026-08-01/);
  await page.getByRole('button', { name: 'Next date' }).click();
  await expect(page).toHaveURL(/mode=Month&date=2026-09-01/);

  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await page.getByRole('button', { name: 'Next date' }).click();
  await expect(page).toHaveURL(/mode=Week&date=2026-09-08/);
  await page.getByRole('button', { name: 'Previous date' }).click();
  const morning = page.getByRole('link', { name: /Mira Editorial, Dispatching/ });
  const lunch = page.getByRole('link', { name: /Mira Editorial, Retrying/ });
  await expect(morning).toHaveAttribute('style', /top: 53\.75px/);
  await expect(lunch).toHaveAttribute('style', /top: 64\.5px/);
  await expect(page.getByRole('link', { name: /Studio Notes, Failed/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Studio Notes, Scheduled/ })).toBeVisible();

  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await page.getByRole('button', { name: 'Next date' }).click();
  await expect(page).toHaveURL(/mode=Day&date=2026-09-02/);
  await page.getByRole('button', { name: 'Previous date' }).click();
  await expect(page.getByLabel('Day calendar').getByRole('link')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('calendar-day.png'), fullPage: true });

  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Next date' }).click();
  await expect(page).toHaveURL(/mode=Timeline&date=2026-09-02/);
  await page.getByRole('button', { name: 'Previous date' }).click();
  await expect(page.locator('.timeline-lane')).toHaveCount(1);
  await expect(page.locator('.timeline-lane').getByRole('link')).toHaveCount(2);
  await expect(page.locator('.timeline-lane').getByRole('link').first()).toHaveAttribute(
    'style',
    /grid-area: 1 \/ 3 \/ auto \/ span 2/,
  );
  await page.clock.setFixedTime(new Date('2026-09-01T05:00:00.000Z'));
  await page.getByRole('button', { name: 'Next date' }).click();
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page).toHaveURL(/mode=Timeline&date=2026-09-01/);
  await expect(page.locator('.timeline-lane').getByRole('link').nth(1)).toHaveAttribute(
    'style',
    /grid-area: 2 \/ 4 \/ auto \/ span 2/,
  );
  await expect(page.locator('.timeline-lane').getByRole('link').first()).toHaveAttribute(
    'href',
    '/w/mira-studio/jobs/mira-morning',
  );
  await page.screenshot({ path: testInfo.outputPath('calendar-timeline.png'), fullPage: true });

  await page.unroute('**/api/workflow/jobs?limit=100');
  await page.route('**/api/workflow/jobs?limit=100', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"data":{"items":[]},"error":null}' }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: '0 accounts' })).toBeVisible();
  await expect(page.locator('.timeline-calendar')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('calendar-empty.png'), fullPage: true });

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
  await page.screenshot({ path: testInfo.outputPath('calendar-error.png'), fullPage: true });
});

test('navigates calendar months across month-end and leap-year boundaries', async ({ page }) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/workflow/jobs?limit=100', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"data":{"items":[]},"error":null}' }),
  );
  await page.goto(await workspacePath(page, 'calendar?mode=Month&date=2027-01-31'));
  await page.getByRole('button', { name: 'Next date' }).click();
  await expect(page).toHaveURL(/mode=Month&date=2027-02-28/);
  await page.goto(await workspacePath(page, 'calendar?mode=Month&date=2028-01-31'));
  await page.getByRole('button', { name: 'Next date' }).click();
  await expect(page).toHaveURL(/mode=Month&date=2028-02-29/);
  await page.getByRole('button', { name: 'Previous date' }).click();
  await expect(page).toHaveURL(/mode=Month&date=2028-01-29/);
});

test('manages workspace settings and API keys with one-time secret and revoke feedback', async ({
  page,
}, testInfo) => {
  let createRequests = 0;
  let revokeRequests = 0;
  let grantRevokeRequests = 0;
  let keys: Record<string, unknown>[] = [];
  let failNextKeyListRefresh = false;
  await establishWorkspaceSession(page);
  await page.route('**/api/workspaces/current', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, string>;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { id: 'workspace-1', ...body }, error: null }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: '{"data":{"id":"workspace-1","name":"Atlas","slug":"atlas","timezone":"Europe/Sofia"},"error":null}',
    });
  });
  await page.route('**/api/settings/api-keys**', async (route) => {
    if (route.request().method() === 'POST') {
      createRequests += 1;
      const input = route.request().postDataJSON() as { label: string; capabilities: string[] };
      if (input.label === 'Fail key') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"data":null,"error":"Creation failed safely"}',
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      keys = [
        {
          id: 'key-2',
          label: input.label,
          prefix: 'pr_new',
          capabilities: input.capabilities,
          createdByDisplayName: 'Mira',
          createdAt: '2026-09-01T00:00:00Z',
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
        },
      ];
      if (input.label === 'Partial key') failNextKeyListRefresh = true;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: '{"data":{"key":{"id":"key-2","prefix":"pr_new"},"token":"pr_new.one-time-secret"},"error":null}',
      });
      return;
    }
    if (route.request().method() === 'DELETE') {
      revokeRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      keys = keys.map((key) => ({ ...key, revokedAt: '2026-09-02T00:00:00Z' }));
      await route.fulfill({
        contentType: 'application/json',
        body: '{"data":{"revoked":true},"error":null}',
      });
      return;
    }
    if (failNextKeyListRefresh) {
      failNextKeyListRefresh = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"data":null,"error":"Refresh unavailable"}',
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: keys }, error: null }),
    });
  });
  await page.route('**/api/settings/delegated-grants**', async (route) => {
    if (route.request().method() === 'DELETE') {
      grantRevokeRequests += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: '{"data":{"revoked":true},"error":null}',
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: '{"data":[{"id":"grant-1","clientId":"Open Clips","scopes":["destinations:read","schedules:write"],"createdAt":"2026-09-10T10:00:00.000Z"}],"error":null}',
    });
  });
  await page.goto(await workspacePath(page, 'settings/workspace'));
  await expect(page.getByRole('heading', { name: 'Workspace profile' })).toBeVisible();
  await page.getByLabel('Name').fill('Atlas Studio');
  await page.getByRole('button', { name: 'Save workspace' }).click();
  await expect(page.getByRole('status')).toContainText('Workspace settings saved');
  await page.getByRole('link', { name: 'Automation' }).click();
  await page.getByLabel('Key name').fill('Agent key');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByRole('button', { name: 'Creating key…' })).toBeDisabled();
  await expect(page.getByText('pr_new.one-time-secret')).toBeVisible();
  expect(createRequests).toBe(1);
  await expect(page.getByText('Created by Mira', { exact: false })).toBeVisible();
  await expect(page.getByText('Created 9/1/2026')).toBeVisible();
  await expect(page.getByText('Expires never')).toBeVisible();
  await expect(page.getByText('Capabilities:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('Revoke this key?')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('settings-automation.png'), fullPage: true });
  await page.getByRole('button', { name: 'Confirm revoke' }).click();
  await expect(page.getByRole('button', { name: 'Revoking key…' })).toBeDisabled();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  expect(revokeRequests).toBe(1);
  await page.getByLabel('Key name').fill('Fail key');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByText('Creation failed safely')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create key' })).toBeEnabled();
  await page.getByLabel('Key name').fill('Partial key');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByText('pr_new.one-time-secret')).toBeVisible();
  await expect(page.getByText(/API key created\. Its secret is safe/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry key list' })).toBeVisible();
  expect(createRequests).toBe(3);
  await page.getByRole('button', { name: 'Retry key list' }).click();
  await expect(page.getByText('Partial key')).toBeVisible();
  expect(createRequests).toBe(3);
  await page.getByRole('link', { name: 'Integrations' }).click();
  await expect(page.getByRole('heading', { name: 'Connected applications' })).toBeVisible();
  await expect(page.getByText('Open Clips', { exact: true })).toBeVisible();
  await expect(page.getByText('Access: destinations:read · schedules:write')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke connection' }).click();
  await expect(page.getByText('Revoke this connection?')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('settings-integrations.png'), fullPage: true });
  await page.getByRole('button', { name: 'Confirm revoke' }).click();
  await expect(page.getByText('No applications connected.')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Application connection revoked');
  expect(grantRevokeRequests).toBe(1);
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
          content: { kind: 'thread', posts: ['Opening post', 'Closing post'] },
          creator: { type: 'api_key', id: 'key-1', label: 'Editorial agent' },
          lastMutator: { type: 'user', id: 'user-1', label: 'Mira' },
          media: [
            {
              id: 'media-1',
              position: 0,
              mimeType: 'image/png',
              state: 'missing',
              previewUrl: null,
            },
          ],
          activity: [
            {
              id: 'event-1',
              fromState: 'dispatching',
              toState: 'accepted_pending',
              reason: 'Provider accepted delivery',
              createdAt: '2026-09-01T09:31:00+03:00',
            },
          ],
          attempts: [
            {
              id: 'attempt-1',
              attemptNumber: 1,
              startedAt: '2026-09-01T09:30:00+03:00',
              finishedAt: null,
              outcome: null,
              retryAt: null,
              error: null,
            },
          ],
          providerResult: { id: 'post-1', url: 'https://x.com/miraeditorial/status/post-1' },
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
  await expect(page.getByText('Provider processing', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Opening post')).toBeVisible();
  await expect(page.getByText('Closing post')).toBeVisible();
  await expect(page.getByText('API key · Editorial agent')).toBeVisible();
  await expect(page.getByText(/Media 1 unavailable/)).toBeVisible();
  await expect(page.getByText('Delivery attempt 1')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View on X' })).toHaveAttribute(
    'href',
    'https://x.com/miraeditorial/status/post-1',
  );
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
  await page.goto(await workspacePath(page, 'jobs/scheduled-job'));
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
    await page.goto(await workspacePath(page, 'queue'));

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
