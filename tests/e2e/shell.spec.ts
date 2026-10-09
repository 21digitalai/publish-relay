import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

interface ErrorHook {
  type: string;
  properties: { area: string; category: string };
}

async function watchErrorHooks(page: Page) {
  await page.addInitScript(() => {
    const scope = window as typeof window & { __relayErrorHooks: ErrorHook[] };
    scope.__relayErrorHooks = [];
    window.addEventListener('publish-relay-analytics', (event) => {
      const detail = (event as CustomEvent<ErrorHook>).detail;
      if (detail.type === 'user_error_shown') scope.__relayErrorHooks.push(detail);
    });
  });
}

async function errorHooks(page: Page): Promise<ErrorHook[]> {
  return page.evaluate(
    () => (window as typeof window & { __relayErrorHooks: ErrorHook[] }).__relayErrorHooks,
  );
}

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
              displayName: 'Example Editorial (@exampleeditorial)',
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
              displayName: 'Avery Studio (@averystudio)',
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

async function mockMetaDestinations(page: Page) {
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: '00000000-0000-4000-8000-000000000211',
              provider: 'meta',
              destinationProvider: 'instagram',
              displayName: '@mira',
              status: 'active',
              availability: 'active',
              capabilityFreshness: 'fresh',
              capabilitySnapshot: { contentKinds: ['single_image', 'carousel'] },
              adapterDefaults: {},
            },
            {
              id: '00000000-0000-4000-8000-000000000212',
              provider: 'meta',
              destinationProvider: 'facebook_page',
              displayName: 'Mira Studio',
              status: 'active',
              availability: 'active',
              capabilityFreshness: 'fresh',
              capabilitySnapshot: { contentKinds: ['link', 'single_image'] },
              adapterDefaults: {},
            },
            {
              id: '00000000-0000-4000-8000-000000000213',
              provider: 'meta',
              destinationProvider: 'instagram',
              displayName: '@missing',
              status: 'active',
              availability: 'remote_missing',
              capabilityFreshness: 'stale',
              capabilitySnapshot: { contentKinds: ['single_image', 'carousel'] },
              adapterDefaults: {},
            },
            ...(['reauth_required', 'permission_lost'] as const).map((availability, index) => ({
              id: `00000000-0000-4000-8000-00000000021${String(index + 4)}`,
              provider: 'meta',
              destinationProvider: 'facebook_page',
              displayName: `Unavailable Page ${String(index + 1)}`,
              status: 'active',
              availability,
              capabilityFreshness: 'stale',
              capabilitySnapshot: { contentKinds: ['link', 'single_image'] },
              adapterDefaults: {},
            })),
          ],
        },
        error: null,
      }),
    }),
  );
}

test('selected Meta grant revoke distinguishes remote and local actions', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await mockMetaDestinations(page);
  let selectedAccountId: string | undefined;
  await page.route('**/api/oauth/meta/revoke', (route) => {
    selectedAccountId = (route.request().postDataJSON() as { accountId: string }).accountId;
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        data: null,
        error: 'Cancel or resolve scheduled publications before revoking this Meta connection',
      }),
    });
  });
  await page.goto(await workspacePath(page, 'accounts'));
  const firstRow = page
    .locator('.provider-group')
    .filter({ has: page.getByRole('heading', { name: 'Meta' }) })
    .locator('.account-row')
    .first();
  await firstRow.getByRole('button', { name: 'Revoke Meta connection' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('every Page and Instagram destination');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath('meta-grant-revoke-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Revoke Meta grant' }).click();
  await expect(page.getByRole('alert')).toContainText('Cancel or resolve scheduled publications');
  expect(selectedAccountId).toBe('00000000-0000-4000-8000-000000000211');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('meta-grant-revoke-error-mobile.png'),
    fullPage: true,
  });
  await firstRow.getByRole('button', { name: 'More actions for @mira' }).click();
  await expect(page.getByRole('alertdialog')).toContainText(
    'only disconnects this account locally',
  );
});

test('Meta revoke pending state survives reload and retry isolates the selected grant', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  let phase: 'active' | 'pending' | 'revoked' | 'reconnected' = 'active';
  let revokeCalls = 0;
  const selected = {
    id: '00000000-0000-4000-8000-000000000221',
    provider: 'meta',
    destinationProvider: 'facebook_page',
    displayName: 'Selected Page',
    availability: 'active',
    capabilitySnapshot: { contentKinds: ['link', 'single_image'] },
    adapterDefaults: {},
  };
  const sibling = {
    ...selected,
    id: '00000000-0000-4000-8000-000000000222',
    displayName: 'Sibling Page',
  };
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            ...(phase === 'revoked'
              ? []
              : [{ ...selected, status: phase === 'pending' ? 'revoking' : 'active' }]),
            { ...sibling, status: 'active' },
          ],
        },
        error: null,
      }),
    }),
  );
  await page.route('**/api/oauth/meta/revoke', (route) => {
    expect((route.request().postDataJSON() as { accountId: string }).accountId).toBe(selected.id);
    revokeCalls += 1;
    phase = revokeCalls === 1 ? 'pending' : 'revoked';
    return route.fulfill({
      status: revokeCalls === 1 ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: revokeCalls === 1 ? null : { revoked: true },
        error:
          revokeCalls === 1
            ? 'Meta grant revocation is pending. Retry Revoke Meta connection to finish; scheduling and reconnect are paused'
            : null,
      }),
    });
  });
  await page.goto(await workspacePath(page, 'accounts'));
  const row = page.locator('.account-row').filter({ hasText: 'Selected Page' });
  await row.getByRole('button', { name: 'Revoke Meta connection' }).click();
  await page.getByRole('button', { name: 'Revoke Meta grant' }).click();
  await expect(page.getByRole('alert')).toContainText('revocation is pending');
  await page.reload();
  await expect(row).toContainText('Revocation pending');
  await expect(row.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
  await expect(page.locator('.account-row').filter({ hasText: 'Sibling Page' })).toContainText(
    'Connected',
  );
  await page.screenshot({
    path: testInfo.outputPath('meta-revoke-pending-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('meta-revoke-pending-mobile.png'),
    fullPage: true,
  });
  await row.getByRole('button', { name: 'Revoke Meta connection' }).click();
  await page.getByRole('button', { name: 'Revoke Meta grant' }).click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(row).toHaveCount(0);
  await expect(page.locator('.account-row').filter({ hasText: 'Sibling Page' })).toBeVisible();
  phase = 'reconnected';
  await page.reload();
  await expect(row).toContainText('Connected');
  expect(revokeCalls).toBe(2);
});

test('computes Meta destination capability intersection on desktop and mobile', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await mockMetaDestinations(page);
  await page.goto(await workspacePath(page, 'accounts'));
  const metaGroup = page
    .locator('.provider-group')
    .filter({ has: page.getByRole('heading', { name: 'Meta' }) });
  await expect(metaGroup.locator('.account-row')).toHaveCount(5);
  await expect(metaGroup.locator('.account-provider')).toContainText([
    'Instagram',
    'Facebook',
    'Instagram',
    'Facebook',
    'Facebook',
  ]);
  await expect(
    metaGroup.getByText('Reconnect Meta and restore publishing permissions.'),
  ).toBeVisible();
  await expect(
    metaGroup.getByText('Reconnect Meta to refresh destinations; history remains available.'),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('meta-accounts.png'), fullPage: true });
  await page.goto(await workspacePath(page, 'queue'));
  await page
    .locator('.page-heading')
    .getByRole('button', { name: /Create post/ })
    .click();
  await page.getByText('Instagram · @mira').click();
  await expect(page.getByRole('button', { name: 'carousel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'link' })).toHaveCount(0);
  await page.getByText('Facebook · Mira Studio').click();
  await expect(page.getByRole('button', { name: 'single image' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'carousel' })).toHaveCount(0);
  await expect(page.getByText(/remote missing · reconnect to schedule/)).toBeVisible();
  await expect(page.locator('.composer-body-heading')).toContainText('0/280 characters');
  await expect(page.locator('.composer-body-heading')).not.toContainText('X post');
  await expect(page.getByText(/reauth required · reconnect to schedule/)).toBeVisible();
  await expect(page.getByText(/permission lost · reconnect to schedule/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('meta-shared-shape.png'), fullPage: true });
  await page.getByText('Instagram · @mira').click();
  await expect(page.getByRole('button', { name: 'link' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'carousel' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.composer-sheet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'link' })).toBeVisible();
  let submitted:
    { content: { kind: string; linkUrl: string }; providerAccountIds: string[] } | undefined;
  await page.route('**/api/workflow/posts', (route) => {
    submitted = route.request().postDataJSON() as typeof submitted;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { jobs: [{}] }, error: null }),
    });
  });
  await page.getByRole('button', { name: 'link' }).click();
  await page.getByPlaceholder('What should your audience know?').fill('Facebook link post');
  await page.getByLabel('HTTPS link').fill('http://example.test');
  await expect(page.getByRole('button', { name: 'Schedule 1 posts' })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('meta-link-validation.png'), fullPage: true });
  await page.getByLabel('HTTPS link').fill('https://example.test');
  await expect(page.getByRole('button', { name: 'Schedule 1 posts' })).toBeEnabled();
  await page.getByRole('button', { name: 'Schedule 1 posts' }).click();
  await expect(page.getByRole('heading', { name: '1 posts scheduled' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('meta-link-success.png'), fullPage: true });
  expect(submitted?.content).toMatchObject({ kind: 'link', linkUrl: 'https://example.test' });
  expect(submitted?.providerAccountIds).toEqual(['00000000-0000-4000-8000-000000000212']);
});

test('validates Instagram carousel and schedules the shared Meta image shape', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await mockMetaDestinations(page);
  let uploadCount = 0;
  await page.route('**/api/workflow/media', (route) => {
    uploadCount += 1;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { id: `00000000-0000-4000-8000-00000000022${String(uploadCount)}` },
        error: null,
      }),
    });
  });
  let submitted:
    { content: { kind: string }; mediaIds: string[]; providerAccountIds: string[] } | undefined;
  await page.route('**/api/workflow/posts', (route) => {
    submitted = route.request().postDataJSON() as typeof submitted;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { jobs: [{}, {}] }, error: null }),
    });
  });
  await page.goto(await workspacePath(page, 'queue'));
  await page
    .locator('.page-heading')
    .getByRole('button', { name: /Create post/ })
    .click();
  for (const name of [
    'Instagram · @missing',
    'Facebook · Unavailable Page 1',
    'Facebook · Unavailable Page 2',
  ])
    await expect(
      page.locator('.account-picker label').filter({ hasText: name }).locator('input'),
    ).toBeDisabled();
  await page.getByText('Instagram · @mira').click();
  await page.getByRole('button', { name: 'carousel' }).click();
  await page.getByPlaceholder('What should your audience know?').fill('Shared Meta image');
  const image = (name: string) => ({
    name,
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  });
  await page.locator('#composer-media-upload').setInputFiles([image('first.png')]);
  await expect(page.getByRole('button', { name: 'Schedule 1 posts' })).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath('meta-carousel-needs-images.png'),
    fullPage: true,
  });
  await page
    .locator('#composer-media-upload')
    .setInputFiles([image('first.png'), image('second.png')]);
  await expect(page.getByRole('button', { name: 'Schedule 1 posts' })).toBeEnabled();
  await page.getByText('Facebook · Mira Studio').click();
  await expect(page.getByRole('button', { name: 'carousel' })).toHaveCount(0);
  await page.locator('#composer-media-upload').setInputFiles([image('shared.png')]);
  await expect(page.getByRole('button', { name: 'Schedule 2 posts' })).toBeEnabled();
  await page.getByRole('button', { name: 'Schedule 2 posts' }).click();
  await expect(page.getByRole('heading', { name: '2 posts scheduled' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('meta-shared-image-success.png'),
    fullPage: true,
  });
  expect(uploadCount).toBe(1);
  expect(submitted?.content.kind).toBe('single_image');
  expect(submitted?.mediaIds).toHaveLength(1);
  expect(submitted?.providerAccountIds).toEqual([
    '00000000-0000-4000-8000-000000000211',
    '00000000-0000-4000-8000-000000000212',
  ]);
});

test('renders the login surface and reports an inline authentication error', async ({
  page,
}, testInfo) => {
  await watchErrorHooks(page);
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
  expect(await errorHooks(page)).toEqual([
    { type: 'user_error_shown', properties: { area: 'auth', category: 'unknown' } },
  ]);
  await page.screenshot({ path: testInfo.outputPath('auth-error.png'), fullPage: true });
});

test('renders the honest recovery unavailable state', async ({ page }) => {
  await page.goto('/forgot-password');
  await expect(page.getByRole('heading', { name: 'Email a recovery link' })).toBeVisible();
  await expect(page.getByText('Password recovery is not available yet.')).toBeVisible();
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
  await expect(page.getByText('1 attached media item selected')).toBeVisible();
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
  await expect(page.getByText('1 attached media item selected')).toBeVisible();
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

test('approves the registered Example Client loopback client and exposes revocation', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await page.route('http://127.0.0.1:43123/callback**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Example Client connected</h1>' }),
  );
  await page.route('**/connect/authorize', async (route) => {
    if (route.request().method() === 'GET') return route.continue();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          authorizationRedirect:
            'http://127.0.0.1:43123/callback?code=opaque-code&state=example-client-state',
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
            clientId: 'example-client-dev',
            scopes: ['destinations:read', 'schedules:write'],
            createdAt: '2026-09-10T10:00:00.000Z',
          },
        ],
        error: null,
      }),
    });
  });
  const query = new URLSearchParams({
    client_id: 'example-client-dev',
    redirect_uri: 'http://127.0.0.1:43123/callback',
    state: 'example-client-state',
    code_challenge: 'c'.repeat(43),
    code_challenge_method: 'S256',
    scope: 'destinations:read schedules:read schedules:write content:write publishes:retry',
  });
  await page.goto(`/connect/authorize?${query}`);
  await expect(page.getByRole('heading', { name: 'Approve access' })).toBeVisible();
  await expect(page.getByText('example-client-dev', { exact: true })).toBeVisible();
  await expect(page.getByText('publishes:retry', { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('example-client-consent.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Approve connection' }).click();
  await page.waitForURL(
    (url) =>
      url.origin === 'http://127.0.0.1:43123' &&
      url.pathname === '/callback' &&
      url.searchParams.has('code') &&
      url.searchParams.get('state') === 'example-client-state',
  );
  expect([...new URL(page.url()).searchParams.keys()].sort()).toEqual(['code', 'state']);
  await page.goto(await workspacePath(page, 'settings/integrations'));
  await expect(page.getByText('example-client-dev', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke connection' }).click();
  await page.getByRole('button', { name: 'Confirm revoke' }).click();
  await expect(page.getByText('No applications connected.')).toBeVisible();
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
  await expect(page.getByRole('button', { name: /X Publish posts and threads/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /YouTube Publish videos/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Instagram/ })).toHaveCount(0);
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
  await page.getByPlaceholder('Search name or handle').fill('Avery');
  await expect(page.getByText('Avery Studio')).toBeVisible();
  await expect(page.getByText('Example Editorial', { exact: true })).toBeHidden();
  await page.getByPlaceholder('Search name or handle').fill('');
  await page.getByRole('button', { name: 'More actions for Studio Notes' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Disconnect Studio Notes?');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('accounts-disconnect.png'), fullPage: true });
});

test('self-declares X long posts per account with persistence and recovery', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  const accountId = '00000000-0000-4000-8000-000000000204';
  let allowed = false;
  let shouldFail = false;
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: accountId,
              provider: 'x',
              destinationProvider: 'x',
              displayName: 'Example Editorial (@example)',
              status: 'active',
              availability: 'active',
              updatedAt: '2026-10-02T00:00:00Z',
              adapterDefaults: {},
              xLongPosts: { allowed, source: 'self_declared', verified: false },
            },
          ],
        },
        error: null,
      }),
    }),
  );
  await page.route('**/api/provider-accounts/*/x-long-posts', async (route) => {
    expect(route.request().method()).toBe('PATCH');
    expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    if (shouldFail) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: 'Setting unavailable' }),
      });
      return;
    }
    allowed = (route.request().postDataJSON() as { allowed: boolean }).allowed;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: { xLongPosts: { allowed, source: 'self_declared', verified: false } },
        error: null,
      }),
    });
  });
  await page.goto(await workspacePath(page, 'accounts'));
  const toggle = page.getByRole('switch', {
    name: 'Allow longer X posts for this account (self-declared)',
  });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('X may reject longer posts')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('x-long-post-off.png'), fullPage: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('x-long-post-on.png'), fullPage: true });
  shouldFail = true;
  await toggle.click();
  await expect(page.getByRole('alert')).toContainText('Setting unavailable');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  shouldFail = false;
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
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
  await page.getByRole('button', { name: 'Add Posting Adapter' }).click();
  await expect(page.getByRole('dialog', { name: 'Add Posting Adapter' })).toBeVisible();
  await expect(page.getByRole('button', { name: /X Publish posts and threads/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /YouTube Publish videos/ })).toBeVisible();
  await page.getByRole('button', { name: 'Close adapter picker' }).press('Shift+Tab');
  await expect(page.getByRole('button', { name: /YouTube Publish videos/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close adapter picker' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Add Posting Adapter' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Posting Adapter' })).toBeFocused();
  await page.getByRole('button', { name: 'Add Posting Adapter' }).click();
  await page.getByRole('button', { name: 'Close adapter picker' }).click();
  await expect(page.getByRole('button', { name: /Connect X/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Connect YouTube/ })).toHaveCount(0);
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
  await page.getByRole('button', { name: 'Add Posting Adapter' }).click();
  await page.getByRole('button', { name: /X Publish posts and threads/ }).click();
  await expect(page.getByText('Example Editorial')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Example Editorial')).toBeVisible();
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
  await page.getByRole('button', { name: 'More actions for Example Editorial' }).click();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.getByRole('button', { name: 'Disconnect account' }).click();
  await expect(page.getByRole('alert')).toContainText('Cancel scheduled jobs');
  await expect(page.getByText('Example Editorial', { exact: true })).toBeVisible();
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
  await expect(page.getByText('Example Editorial', { exact: true })).toBeVisible();
  await expect(page.getByText('Studio Notes', { exact: true })).toBeHidden();
  await page.screenshot({
    path: testInfo.outputPath('accounts-disconnect-success.png'),
    fullPage: true,
  });
});

test('opens the composer from Accounts with no connected destinations', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await page.goto(await workspacePath(page, 'accounts'));
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('button', { name: 'Create post' }).click();
  await expect(page).toHaveURL(/\/queue$/);
  await expect(page.getByRole('dialog', { name: 'Create post' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Connect an account to create a post' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add Posting Adapter' })).toHaveAttribute(
    'href',
    /\/w\/[^/]+\/accounts$/,
  );
  await expect(page.getByRole('button', { name: /Schedule \d+ posts?/ })).toHaveCount(0);
  await expect(page.getByLabel('Post body')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Create post' })).toHaveCount(0);
});

test('recovers the composer account gate after a failed account load', async ({ page }) => {
  await establishWorkspaceSession(page);
  await page.goto(await workspacePath(page, 'queue'));
  let requests = 0;
  let shouldFail = true;
  await page.route('**/api/provider-accounts', (route) => {
    requests += 1;
    return route.fulfill(
      shouldFail
        ? { status: 503, contentType: 'application/json', body: '{"data":null,"error":"offline"}' }
        : {
            contentType: 'application/json',
            body: JSON.stringify({ data: { accounts: [] }, error: null }),
          },
    );
  });
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await expect(page.getByRole('heading', { name: 'Connected accounts unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Schedule \d+ posts?/ })).toHaveCount(0);
  shouldFail = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(
    page.getByRole('heading', { name: 'Connect an account to create a post' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add Posting Adapter' })).toHaveAttribute(
    'href',
    /\/w\/[^/]+\/accounts$/,
  );
  expect(requests).toBeGreaterThanOrEqual(2);
});

test('shows LinkedIn expiry and prevents scheduling after the token lifetime', async ({
  page,
}, testInfo) => {
  await watchErrorHooks(page);
  await establishWorkspaceSession(page);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: '00000000-0000-4000-8000-000000000299',
              provider: 'linkedin',
              displayName: 'Member One',
              status: 'active',
              expiresAt,
              updatedAt: new Date().toISOString(),
              adapterDefaults: {},
            },
          ],
        },
        error: null,
      }),
    }),
  );
  await page.goto(await workspacePath(page, 'accounts'));
  await expect(
    page.getByRole('complementary', { name: 'LinkedIn connection warnings' }),
  ).toBeVisible();
  await expect(
    page.getByText(/LinkedIn access for Member One expires within 1 day/).first(),
  ).toBeVisible();
  await expect(page.getByText('In-app LinkedIn connection warning')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Account health summary' })).toContainText(
    '1Connected accounts0Healthy1Needs attention',
  );
  await expect(page.locator('.account-row .status-badge')).toHaveText('! Needs attention');
  await page.locator('.health-filter').selectOption('Needs attention');
  await expect(page.locator('.account-row')).toHaveCount(1);
  await page.locator('.health-filter').selectOption('Connected');
  await expect(page.locator('.account-row')).toHaveCount(0);
  await page.locator('.health-filter').selectOption('All health');
  await expect(page.locator('.account-row')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Reconnect Member One' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('linkedin-expiry-account.png'),
    fullPage: true,
  });
  await page.route('**/api/oauth/linkedin', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: 'Reconnect is temporarily unavailable' }),
    }),
  );
  await page.getByRole('button', { name: 'Reconnect Member One' }).click();
  await expect(page.getByText('Reconnect is temporarily unavailable')).toBeVisible();
  expect(
    (await errorHooks(page)).filter((event) => event.properties.area === 'connection'),
  ).toEqual([
    { type: 'user_error_shown', properties: { area: 'connection', category: 'provider' } },
  ]);
  if (testInfo.project.name === 'mobile')
    await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Create post' }).click();
  await expect(
    page.getByRole('complementary', { name: 'LinkedIn connection warnings' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Create post' })).toBeVisible();
  await expect(
    page.getByText(
      'LinkedIn access expires before this post. Reconnect the account or choose an earlier time.',
    ),
  ).toBeVisible();
  expect((await errorHooks(page)).filter((event) => event.properties.area === 'composer')).toEqual([
    { type: 'user_error_shown', properties: { area: 'composer', category: 'provider' } },
  ]);
  await expect(page.getByRole('button', { name: /Schedule 1 post/ })).toBeDisabled();
  await expect(page.locator('.composer-body')).toHaveAttribute('maxlength', '3000');
  await expect(page.getByText('Choose files')).toHaveCount(0);
  await expect(page.locator('#composer-media-upload')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('linkedin-expiry-composer.png'),
    fullPage: true,
  });
});

test('LinkedIn reconnect sends selected account and explains member mismatch', async ({ page }) => {
  await watchErrorHooks(page);
  await establishWorkspaceSession(page);
  const accountId = '00000000-0000-4000-8000-000000000299';
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: accountId,
              provider: 'linkedin',
              displayName: 'Member B',
              status: 'reconnect_required',
              updatedAt: new Date().toISOString(),
              adapterDefaults: {},
            },
          ],
        },
        error: null,
      }),
    }),
  );
  let reconnectBody: unknown;
  await page.route('**/api/oauth/linkedin', (route) => {
    reconnectBody = route.request().postDataJSON();
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: 'Reconnect unavailable' }),
    });
  });
  await page.goto(await workspacePath(page, 'accounts'));
  await page.getByRole('button', { name: 'Reconnect' }).click();
  await expect(page.getByText('Reconnect unavailable')).toBeVisible();
  expect(
    (await errorHooks(page)).filter((event) => event.properties.area === 'connection'),
  ).toEqual([
    { type: 'user_error_shown', properties: { area: 'connection', category: 'unknown' } },
  ]);
  expect(reconnectBody).toEqual({ accountId });
  await page.goto('/app?oauth=linkedin-member-mismatch');
  await expect(
    page.getByRole('alert').filter({ hasText: 'A different LinkedIn member signed in' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();
});

test('OAuth callback failures show safe guidance on desktop and mobile', async ({ page }) => {
  await watchErrorHooks(page);
  await establishWorkspaceSession(page);
  await page.goto('/app?oauth=linkedin-permission-unavailable');
  await expect(
    page.getByRole('alert').filter({ hasText: 'OpenID Connect permission' }),
  ).toBeVisible();
  expect(await errorHooks(page)).toEqual([
    { type: 'user_error_shown', properties: { area: 'connection', category: 'provider' } },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app?oauth=meta-service-error&code=secret-code&state=secret-state');
  const alert = page.getByRole('alert').filter({ hasText: 'No Meta account was connected' });
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText(/secret-code|secret-state/);
  await expect(page.getByRole('button', { name: 'Add Posting Adapter' })).toBeVisible();
});

test('empty Instagram discovery is an actionable error without a phantom success row', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await page.goto('/app?oauth=meta-instagram-no-accounts');
  await expect(page.getByRole('alert')).toContainText(
    'No eligible linked Instagram account was found',
  );
  await expect(page.getByLabel('Account health summary')).toContainText('0Connected accounts');
  await expect(page.getByRole('heading', { name: 'Connect your first account' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('instagram-no-accounts-first.png'),
    fullPage: true,
  });

  await mockMetaDestinations(page);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText(
    'Your previous Instagram connection, if any, was kept',
  );
  await expect(page.locator('.account-row').filter({ hasText: '@mira' }).first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('instagram-no-accounts-reconnect.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app?oauth=meta-instagram-connected');
  await expect(page.locator('.account-row').filter({ hasText: '@mira' }).first()).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: 'No eligible linked Instagram' }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('instagram-connected.png'), fullPage: true });
});

test('Meta picker offers two consent families and never starts the combined route', async ({
  page,
}) => {
  await establishWorkspaceSession(page);
  const starts: string[] = [];
  await page.route('**/api/oauth/meta/**', (route) => {
    starts.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: 'This family is not configured yet' }),
    });
  });
  await page.goto(await workspacePath(page, 'accounts'));
  await page.getByRole('button', { name: 'Add Posting Adapter' }).click();
  await expect(page.getByRole('button', { name: /^Facebook Pages / })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Instagram / })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Meta$/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^Facebook Pages / }).click();
  await expect(page.getByRole('alert')).toContainText('This family is not configured yet');
  await page.getByRole('button', { name: 'Add Posting Adapter' }).click();
  await page.getByRole('button', { name: /^Instagram / }).click();
  expect(starts).toEqual(['/api/oauth/meta/facebook-pages', '/api/oauth/meta/instagram']);
});

test('LinkedIn health failure emits one anonymous connection error', async ({ page }) => {
  await watchErrorHooks(page);
  await establishWorkspaceSession(page);
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({ status: 503, body: '{"data":null,"error":"private detail"}' }),
  );
  await page.goto(await workspacePath(page, 'queue'));
  await expect(page.getByText('LinkedIn connection health could not be loaded.')).toBeVisible();
  expect(
    (await errorHooks(page)).filter((event) => event.properties.area === 'connection'),
  ).toEqual([
    { type: 'user_error_shown', properties: { area: 'connection', category: 'network' } },
  ]);
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
  await watchErrorHooks(page);
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
                displayName: 'Example Editorial',
                handle: 'exampleeditorial',
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
                      displayName: 'Example Editorial',
                      handle: 'exampleeditorial',
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
                displayName: 'Example Editorial',
                handle: 'exampleeditorial',
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
            displayName: 'Example Editorial',
            handle: 'exampleeditorial',
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
  await expect(page.getByLabel('Post body')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('composer.png'), fullPage: true });
  await expect(page.getByText('Choose files')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Schedule 2 posts' })).toBeDisabled();
  await page.getByLabel('Post body').fill('A clear publishing update for two accounts.');
  const scheduleDate = page.getByLabel('Date', { exact: true });
  const scheduleTime = page.getByLabel('Time', { exact: true });
  await expect(page.getByRole('button', { name: 'Open date picker' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open time picker' })).toBeVisible();
  if (testInfo.project.name === 'mobile') {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  }
  await scheduleDate.fill('2026-09-01');
  await scheduleTime.fill('09:30');
  await expect(page.getByText('1 nearby publication detected')).toBeVisible();
  await page.getByRole('button', { name: 'Use next 15-minute opening' }).click();
  await expect(scheduleDate).toHaveValue('2026-09-01');
  await expect(scheduleTime).toHaveValue('10:05');
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
  await scheduleDate.fill('2020-01-01');
  await scheduleTime.fill('09:00');
  await expect(page.getByRole('alert')).toContainText('future publishing time');
  await expect(page.getByRole('button', { name: 'Schedule 2 posts' })).toBeDisabled();
  await scheduleDate.fill('2026-09-01');
  await scheduleTime.fill('10:05');
  await expect(page.getByRole('button', { name: 'Schedule 2 posts' })).toBeEnabled();
  await page.getByRole('button', { name: 'Schedule 2 posts' }).click();
  await expect(page.getByRole('alert')).toContainText('Retry safely');
  await page.getByRole('button', { name: 'Confirm previous request' }).click();
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
      await expect(page.getByLabel('Day calendar').getByText('Example Editorial')).toBeVisible();
    }
    await page.screenshot({
      path: testInfo.outputPath(`calendar-${mode.toLowerCase()}.png`),
      fullPage: true,
    });
  }
  await page.goto(await workspacePath(page, 'jobs/job-2048'));
  await expect(page.getByRole('heading', { name: 'Example Editorial' })).toBeVisible();
  await expect(page.getByRole('status')).toBeEmpty();
  await page.screenshot({ path: testInfo.outputPath('job-detail-failed.png'), fullPage: true });
  await page.getByRole('button', { name: 'Retry now' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('preventing a duplicate post');
  await expect(page.getByRole('button', { name: 'Keep job' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('job-retry-confirm.png'), fullPage: true });
  await page.getByRole('button', { name: 'Retry safely' }).click();
  await expect(page.getByText('Retry service unavailable', { exact: true })).toBeVisible();
  expect(
    (await errorHooks(page)).filter((event) => event.properties.area === 'publishing'),
  ).toEqual([
    { type: 'user_error_shown', properties: { area: 'publishing', category: 'unknown' } },
  ]);
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
  expect(
    (await errorHooks(page)).filter((event) => event.properties.area === 'publishing'),
  ).toEqual([
    { type: 'user_error_shown', properties: { area: 'publishing', category: 'unknown' } },
  ]);
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

test('dismisses the composer safely and restores its Create post trigger', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await mockConnectedAccounts(page);
  await page.goto(await workspacePath(page, 'queue'));
  const trigger = page.getByRole('button', { name: 'Create post' }).last();
  const dialog = page.getByRole('dialog', { name: 'Create post' });

  await trigger.click();
  await dialog.getByText('Add media', { exact: true }).click();
  await expect(dialog).toBeVisible();
  if (testInfo.project.name === 'desktop') {
    await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
  }
  await dialog.getByPlaceholder('What should your audience know?').focus();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('selects and schedules X image media through the canonical composer', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: '00000000-0000-4000-8000-000000000201',
              provider: 'x',
              displayName: 'Example Editorial',
              status: 'active',
              adapterDefaults: {},
            },
          ],
        },
        error: null,
      }),
    }),
  );
  const uploads: string[] = [];
  await page.route('**/api/workflow/media', (route) => {
    uploads.push(route.request().headers()['content-type'] ?? '');
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: `media-${String(uploads.length)}` }, error: null }),
    });
  });
  let submittedMedia: string[] = [];
  await page.route('**/api/workflow/posts', (route) => {
    submittedMedia = (route.request().postDataJSON() as { mediaIds: string[] }).mediaIds;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { jobs: [{}] }, error: null }),
    });
  });
  await page.goto(await workspacePath(page, 'queue'));
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await page.getByPlaceholder('What should your audience know?').fill('Image post');
  await page
    .locator('#composer-media-upload')
    .setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') });
  await expect(page.getByRole('alert')).toContainText('supported image');
  await expect(page.locator('.composer-media-attachment')).toHaveCount(0);
  await page.locator('#composer-media-upload').focus();
  const keyboardChooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Space');
  await (
    await keyboardChooser
  ).setFiles({
    name: 'keyboard.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  });
  await expect(page.locator('.composer-media-attachment')).toContainText('keyboard.png');
  const fileChooser = page.waitForEvent('filechooser');
  await page.getByText('Choose files').click();
  await (
    await fileChooser
  ).setFiles({
    name: 'image.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  });
  await expect(page.locator('.composer-media-attachment')).toContainText('image.png');
  await page.screenshot({ path: testInfo.outputPath('x-media-attached.png'), fullPage: true });
  await page.getByRole('button', { name: 'Schedule 1 posts' }).click();
  await expect(page.getByRole('heading', { name: '1 posts scheduled' })).toBeVisible();
  expect(uploads).toEqual(['image/png']);
  expect(submittedMedia).toEqual(['media-1']);
});

test('retries partial X uploads and a rejected post without replaying deleted media', async ({
  page,
}) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: '00000000-0000-4000-8000-000000000201',
              provider: 'x',
              displayName: 'Example Editorial',
              status: 'active',
              adapterDefaults: {},
            },
          ],
        },
      }),
    }),
  );
  await page.route('**/api/workflow/jobs?*', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"data":{"items":[],"next":null}}' }),
  );
  const uploadKeys: string[] = [];
  const deleted: string[] = [];
  let uploadCount = 0;
  let postCount = 0;
  await page.route('**/api/workflow/media', (route) => {
    uploadCount += 1;
    uploadKeys.push(route.request().headers()['idempotency-key'] ?? '');
    if (uploadCount === 2)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"Upload unavailable"}',
      });
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: `media-${String(uploadCount)}` } }),
    });
  });
  await page.route('**/api/workflow/media/*', (route) => {
    deleted.push(route.request().url());
    return route.fulfill({ contentType: 'application/json', body: '{"data":{"deleted":true}}' });
  });
  await page.route('**/api/workflow/posts', (route) => {
    postCount += 1;
    if (postCount === 1)
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: '{"error":"Post rejected"}',
      });
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: '{"data":{"jobs":[{}]}}',
    });
  });
  await page.goto(await workspacePath(page, 'queue'));
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await page.getByLabel('Post body').fill('Two image retry');
  await page.locator('#composer-media-upload').setInputFiles(
    ['one.png', 'two.png'].map((name) => ({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    })),
  );
  const schedule = page.getByRole('button', { name: 'Schedule 1 posts' });
  await schedule.click();
  await expect(page.getByRole('alert')).toContainText('Upload unavailable');
  expect(deleted).toHaveLength(1);
  await schedule.click();
  await expect(page.getByRole('alert')).toContainText('Post rejected');
  expect(deleted).toHaveLength(3);
  await schedule.click();
  await expect(page.getByRole('heading', { name: '1 posts scheduled' })).toBeVisible();
  expect(uploadKeys).toHaveLength(6);
  expect(new Set(uploadKeys).size).toBe(6);
  expect(postCount).toBe(2);
});

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`freezes uncertain X media intent before file replacement at ${String(viewport.width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await establishWorkspaceSession(page);
    await page.route('**/api/provider-accounts', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            accounts: [
              {
                id: '00000000-0000-4000-8000-000000000201',
                provider: 'x',
                displayName: 'Example Editorial',
                status: 'active',
                adapterDefaults: {},
              },
            ],
          },
        }),
      }),
    );
    await page.route('**/api/workflow/jobs?*', (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"data":{"items":[],"next":null}}' }),
    );
    const uploads: { bytes: string; key: string; id: string }[] = [];
    const posts: { key: string; body: string; mediaIds: string[] }[] = [];
    await page.route('**/api/workflow/media', (route) => {
      const id = `media-${String(uploads.length + 1)}`;
      uploads.push({
        bytes: route.request().postDataBuffer()?.toString('hex') ?? '',
        key: route.request().headers()['idempotency-key'] ?? '',
        id,
      });
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ data: { id } }),
      });
    });
    await page.route('**/api/workflow/posts', (route) => {
      posts.push({
        key: route.request().headers()['idempotency-key'] ?? '',
        body: route.request().postData() ?? '',
        mediaIds: (route.request().postDataJSON() as { mediaIds: string[] }).mediaIds,
      });
      return route.fulfill({
        status: posts.length === 1 ? 503 : 201,
        contentType: 'application/json',
        body: posts.length === 1 ? '{"error":"Uncertain response"}' : '{"data":{"jobs":[{}]}}',
      });
    });
    await page.goto(await workspacePath(page, 'queue'));
    await page.getByRole('button', { name: 'Create post' }).last().click();
    await page.getByLabel('Post body').fill('Image A');
    const input = page.locator('#composer-media-upload');
    await input.setInputFiles({
      name: 'image.png',
      mimeType: 'image/png',
      buffer: Buffer.from('image A'),
    });
    await page.getByRole('button', { name: 'Schedule 1 posts' }).click();
    await expect(page.getByRole('alert')).toContainText('Outcome uncertain');
    await expect(page.getByText('Editing is paused')).toBeVisible();
    await input.setInputFiles({
      name: 'image.png',
      mimeType: 'image/png',
      buffer: Buffer.from('image B'),
    });
    await expect(page.getByRole('alert')).toContainText('Confirm the previous request');
    await expect(page.locator('.composer-media-attachment')).toContainText('image.png');
    expect(uploads).toHaveLength(1);
    expect(posts).toHaveLength(1);
    await page.getByRole('button', { name: 'Confirm previous request' }).click();
    await expect(page.getByRole('heading', { name: '1 posts scheduled' })).toBeVisible();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(uploads[0]?.bytes).toBe(Buffer.from('image A').toString('hex'));
    await page.getByRole('button', { name: 'Close composer' }).click();
    await page.getByRole('button', { name: 'Create post' }).last().click();
    await page.getByLabel('Post body').fill('Image B');
    await page.locator('#composer-media-upload').setInputFiles({
      name: 'image.png',
      mimeType: 'image/png',
      buffer: Buffer.from('image B'),
    });
    await page.getByRole('button', { name: 'Schedule 1 posts' }).click();
    await expect(page.getByRole('heading', { name: '1 posts scheduled' })).toBeVisible();
    expect(uploads[1]?.bytes).toBe(Buffer.from('image B').toString('hex'));
    expect(uploads[1]?.id).not.toBe(uploads[0]?.id);
    expect(uploads[1]?.key).not.toBe(uploads[0]?.key);
    expect(posts[2]?.mediaIds).toEqual([uploads[1]?.id]);
    expect(posts[2]?.key).not.toBe(posts[0]?.key);
  });
}

test('uses consistent workspace actions and readable X composer fields', async ({
  page,
}, testInfo) => {
  await watchErrorHooks(page);
  await establishWorkspaceSession(page);
  await page.goto(await workspacePath(page, 'settings/workspace'));
  const save = page.getByRole('button', { name: 'Save workspace' });
  const create = page.getByRole('button', { name: 'Create workspace' });
  await expect(save).toHaveClass(/primary-button/);
  await expect(create).toHaveClass(/primary-button/);
  await expect(save).toHaveCSS('background-color', 'rgb(163, 255, 79)');
  await expect(create).toHaveCSS('background-color', 'rgb(163, 255, 79)');
  await page.screenshot({ path: testInfo.outputPath('workspace-actions.png'), fullPage: true });

  await mockConnectedAccounts(page);
  await page.goto(await workspacePath(page, 'queue'));
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await page.getByRole('checkbox', { name: /Instagram · Avery Studio/ }).uncheck();
  await page
    .getByRole('dialog', { name: 'Create post' })
    .getByText('Add media', { exact: true })
    .click();
  await page.locator('#composer-media-upload').setInputFiles({
    name: 'unsupported.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('invalid'),
  });
  await expect(page.getByRole('alert')).toContainText('Choose a supported image');
  expect((await errorHooks(page)).filter((event) => event.properties.area === 'composer')).toEqual([
    { type: 'user_error_shown', properties: { area: 'composer', category: 'validation' } },
  ]);
  const body = page.getByPlaceholder('What should your audience know?');
  await expect(body).toHaveCSS('display', 'block');
  await expect(page.locator('.composer-body-heading')).toContainText('Post body');
  await expect(page.locator('.composer-body-heading')).toContainText(
    '0/280 weighted characters per X post',
  );
  await page.screenshot({ path: testInfo.outputPath('composer-body.png'), fullPage: true });
});

test('uses the selected X account weighted limit on desktop and mobile', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: '00000000-0000-4000-8000-000000000221',
              provider: 'x',
              displayName: 'Long account',
              status: 'active',
              availability: 'active',
              adapterDefaults: {},
              xLongPosts: { allowed: true, source: 'self_declared', verified: false },
            },
            {
              id: '00000000-0000-4000-8000-000000000222',
              provider: 'x',
              displayName: 'Standard account',
              status: 'active',
              availability: 'active',
              adapterDefaults: {},
              xLongPosts: { allowed: false, source: 'self_declared', verified: false },
            },
          ],
        },
        error: null,
      }),
    }),
  );
  for (const [label, width, height] of [
    ['desktop', 1440, 900],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(await workspacePath(page, 'queue'));
    await page.getByRole('button', { name: 'Create post' }).last().click();
    const body = page.getByPlaceholder('What should your audience know?');
    const heading = page.locator('.composer-body-heading');
    const submit = page.getByRole('button', { name: 'Schedule 2 posts' });
    await body.fill('a'.repeat(281));
    await expect(heading).toContainText('281/280 weighted characters');
    await expect(submit).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('280 weighted-character limit');
    await page.screenshot({ path: testInfo.outputPath(`x-mixed-${label}.png`), fullPage: true });
    await page.getByLabel('Standard account').uncheck();
    await expect(heading).toContainText('281/25000 weighted characters');
    await expect(page.getByText('Long-post access is self-declared, not verified.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Schedule 1 posts' })).toBeEnabled();
    await body.fill('a'.repeat(25_000));
    await expect(heading).toContainText('25000/25000 weighted characters');
    await expect(page.getByRole('button', { name: 'Schedule 1 posts' })).toBeEnabled();
    await body.fill('a'.repeat(25_001));
    await expect(heading).toContainText('25001/25000 weighted characters');
    await expect(page.getByRole('button', { name: 'Schedule 1 posts' })).toBeDisabled();
    await body.fill('Ж'.repeat(125) + '😀'.repeat(16));
    await expect(heading).toContainText('157/25000 weighted characters');
    await page.screenshot({ path: testInfo.outputPath(`x-long-${label}.png`), fullPage: true });
  }
});

test('retries uncertain YouTube post responses without deleting media', async ({ page }) => {
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
  expect(deletedMedia).toHaveLength(0);
  await page.getByRole('button', { name: 'Confirm previous request' }).click();
  await expect(page.getByRole('heading', { name: '1 posts scheduled' })).toBeVisible();
  const settings = page.getByLabel('YouTube settings');
  await expect(settings).toContainText('Visibilitypublic');
  await expect(settings).toContainText('Made for kidsNo');
  await expect(settings).toContainText('Notify subscribersYes');
  expect(uploadCount).toBe(1);
  expect(deletedMedia).toHaveLength(0);
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
  await page.getByLabel('Date', { exact: true }).fill('2026-09-01');
  await page.getByLabel('Time', { exact: true }).fill('10:05');
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
              providerAccount: {
                displayName: 'Example Editorial',
                handle: 'exampleeditorial',
                provider: 'x',
              },
            },
            {
              id: 'retry-job',
              state: 'retry_wait',
              scheduledAt: '2026-09-01T10:30:00+03:00',
              contentPreview: 'Waiting to retry',
              providerAccount: {
                displayName: 'Example Editorial',
                handle: 'exampleeditorial',
                provider: 'x',
              },
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
              id: 'avery-morning',
              state: 'dispatching',
              scheduledAt: '2026-09-01T09:15:00+03:00',
              contentPreview: 'Morning dispatch',
              providerAccount: { displayName: 'Avery Editorial', handle: 'avery', provider: 'x' },
            },
            {
              id: 'avery-lunch',
              state: 'retry_wait',
              scheduledAt: '2026-09-01T09:30:00+03:00',
              contentPreview: 'Lunch retry',
              providerAccount: { displayName: 'Avery Editorial', handle: 'avery', provider: 'x' },
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
  await page.goto('/w/avery-studio/calendar?mode=Week&date=2026-09-01');
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
    '/w/avery-studio/jobs/avery-morning',
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
  const morning = page.getByRole('link', { name: /Avery Editorial, Dispatching/ });
  const lunch = page.getByRole('link', { name: /Avery Editorial, Retrying/ });
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
    '/w/avery-studio/jobs/avery-morning',
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

test('refreshes background publication outcomes without replaying historical toasts', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await page.clock.install();
  let state = 'scheduled';
  let polls = 0;
  await page.route('**/api/workflow/jobs?limit=100', (route) => {
    polls += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: [
            {
              id: 'outcome-job',
              state,
              scheduledAt: '2026-10-01T12:00:00Z',
              contentPreview: 'Publication update',
              providerAccount: { displayName: 'Avery Editorial', handle: 'avery', provider: 'x' },
            },
          ],
        },
        error: null,
      }),
    });
  });
  await page.route('**/api/workflow/jobs/outcome-job', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: { state, providerResult: { url: 'https://x.com/avery/status/123' } },
        error: null,
      }),
    }),
  );
  await page.goto('/w/avery/calendar?mode=Week&date=2026-10-01');
  await expect(page.getByRole('link', { name: /Avery Editorial, Scheduled/ })).toBeVisible();
  expect(await page.getByText('Published on X').count()).toBe(0);
  state = 'published';
  await page.clock.fastForward(10_000);
  await expect(page.getByRole('link', { name: /Avery Editorial, Published/ })).toBeVisible();
  await expect(page.locator('.publication-toast')).toHaveCount(1);
  await expect(
    page.locator('.publication-toast').getByRole('link', { name: 'View post' }),
  ).toHaveAttribute('href', 'https://x.com/avery/status/123');
  await page.screenshot({
    path: testInfo.outputPath('publication-toast.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.publication-toast')).toHaveCount(1);
  expect(polls).toBeGreaterThanOrEqual(2);
  await page.reload();
  await expect(page.getByRole('link', { name: /Avery Editorial, Published/ })).toBeVisible();
  await expect(page.locator('.publication-toast')).toHaveCount(0);

  state = 'scheduled';
  await page.goto('/w/avery/queue');
  await expect(page.locator('.queue-row').getByText('Scheduled')).toBeVisible();
  state = 'retry_wait';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.queue-row').getByText('Retrying')).toBeVisible();
  await expect(page.locator('.publication-toast')).toHaveCount(0);
  state = 'failed';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.queue-row').getByText('Failed')).toBeVisible();
  await expect(page.locator('.publication-toast')).toHaveCount(1);
  await expect(page.locator('.publication-toast')).toContainText('Post needs attention');
  await expect(
    page.locator('.publication-toast').getByRole('link', { name: 'View details' }),
  ).toHaveAttribute('href', '/w/avery/jobs/outcome-job');
});

test('shows published jobs as success across calendar modes after reload', async ({ page }) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/workflow/jobs?limit=100', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: [
            {
              id: 'published-job',
              state: 'published',
              scheduledAt: '2026-09-01T09:15:00+03:00',
              contentPreview: 'Published update',
              providerAccount: {
                displayName: 'Example Editorial',
                handle: 'exampleeditorial',
                provider: 'x',
              },
            },
          ],
        },
        error: null,
      }),
    }),
  );
  await page.goto(await workspacePath(page, 'calendar?mode=Month&date=2026-09-01'));
  for (const [mode, selector] of [
    ['Month', '.calendar-job.published'],
    ['Week', '.calendar-block.published'],
    ['Day', '.calendar-block.published'],
    ['Timeline', '.timeline-job.published'],
  ] as const) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    const published = page.locator(selector);
    await expect(published).toHaveCount(1);
    await expect(published).toHaveAttribute('aria-label', /Example Editorial, Published/);
    await expect(published.locator('.calendar-published-mark')).toContainText('Published');
  }
  await page.reload();
  await expect(page.locator('.timeline-job.published')).toHaveCount(1);
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
  let workspaceCreateRequests = 0;
  let workspaceOrderRequests = 0;
  let keys: Record<string, unknown>[] = [];
  let workspaces = [
    { id: 'workspace-1', name: 'Atlas', slug: 'atlas', role: 'owner', position: 0 },
    { id: 'workspace-2', name: 'Relay', slug: 'relay', role: 'owner', position: 1 },
  ];
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
  await page.route('**/api/workspaces', async (route) => {
    if (route.request().method() === 'POST') {
      workspaceCreateRequests += 1;
      const input = route.request().postDataJSON() as { name: string };
      const workspace = {
        id: 'workspace-3',
        name: input.name,
        slug: 'new-desk',
        role: 'owner',
        position: workspaces.length,
      };
      workspaces = [...workspaces, workspace];
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ data: workspace, error: null }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { workspaces }, error: null }),
    });
  });
  await page.route('**/api/workspaces/order', async (route) => {
    workspaceOrderRequests += 1;
    const input = route.request().postDataJSON() as { workspaceIds: string[] };
    workspaces = input.workspaceIds.flatMap((id, position) => {
      const workspace = workspaces.find((candidate) => candidate.id === id);
      return workspace ? [{ ...workspace, position }] : [];
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { workspaces }, error: null }),
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
          createdByDisplayName: 'Avery',
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
      body: '{"data":[{"id":"grant-1","clientId":"Example Client","scopes":["destinations:read","schedules:write"],"createdAt":"2026-09-10T10:00:00.000Z"}],"error":null}',
    });
  });
  await page.goto(await workspacePath(page, 'settings/workspace'));
  await expect(page.getByRole('heading', { name: 'Workspace profile' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Manage workspaces' })).toBeVisible();
  await page.getByLabel('New workspace name').fill('New Desk');
  await page.getByRole('button', { name: 'Create workspace' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole('button', { name: 'Creating workspace…' })).toBeDisabled();
  await expect(page.getByText('New Desk', { exact: true })).toBeVisible();
  expect(workspaceCreateRequests).toBe(1);
  await page.getByRole('button', { name: 'Move New Desk up' }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole('button', { name: 'Move New Desk up' })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Workspace order saved');
  expect(workspaceOrderRequests).toBe(1);
  await page.getByLabel('Name', { exact: true }).fill('Atlas Studio');
  await page.getByRole('button', { name: 'Save workspace' }).click();
  await expect(page.getByRole('status')).toContainText('Workspace settings saved');
  await page.getByRole('link', { name: 'Automation' }).click();
  await page.getByLabel('Key name').fill('Agent key');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByRole('button', { name: 'Creating key…' })).toBeDisabled();
  await expect(page.getByText('pr_new.one-time-secret')).toBeVisible();
  expect(createRequests).toBe(1);
  await expect(page.getByText('Created by Avery', { exact: false })).toBeVisible();
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
  await expect(page.getByText('Example Client', { exact: true })).toBeVisible();
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
          lastMutator: { type: 'user', id: 'user-1', label: 'Avery' },
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
          providerResult: { id: 'post-1', url: 'https://x.com/averyeditorial/status/post-1' },
          providerAccount: {
            displayName: 'Avery Editorial',
            handle: 'averyeditorial',
            provider: 'x',
          },
        },
        error: null,
      }),
    });
  });
  await page.goto('/w/avery-studio/jobs/pending-job');
  await expect(page.getByRole('status')).toContainText('Loading publication job');
  await expect(page.getByRole('heading', { name: 'Avery Editorial' })).toBeVisible();
  await expect(page.getByText('Provider processing', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Opening post')).toBeVisible();
  await expect(page.getByText('Closing post')).toBeVisible();
  await expect(page.getByText('API key · Editorial agent')).toBeVisible();
  await expect(page.getByText(/Media 1 unavailable/)).toBeVisible();
  await expect(page.getByText('Delivery attempt 1')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View on X' })).toHaveAttribute(
    'href',
    'https://x.com/averyeditorial/status/post-1',
  );
  await expect(page.getByRole('link', { name: /Back to queue/ })).toHaveAttribute(
    'href',
    '/w/avery-studio/queue',
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
    '/w/avery-studio/queue',
  );
});

test('edits a scheduled job through the canonical browser revision route', async ({ page }) => {
  await watchErrorHooks(page);
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
            displayName: 'Example Editorial',
            handle: 'exampleeditorial',
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
  expect(
    (await errorHooks(page)).filter((event) => event.properties.area === 'scheduling'),
  ).toEqual([
    { type: 'user_error_shown', properties: { area: 'scheduling', category: 'unknown' } },
  ]);
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
      await page.getByLabel('Date', { exact: true }).fill('2027-03-28');
      await page.getByLabel('Time', { exact: true }).fill('03:30');
      await expect(page.getByRole('alert')).toContainText('clock changes');
      await expect(page.getByRole('button', { name: 'Schedule 2 posts' })).toBeDisabled();
      await page.getByLabel('Date', { exact: true }).fill('2027-10-31');
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
