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

async function selectComposerAccount(page: Page, name: string) {
  const change = page.getByRole('button', { name: 'Change account' });
  if (await change.isVisible().catch(() => false)) await change.click();
  await page.locator('.account-picker label').filter({ hasText: name }).locator('input').click();
}

test('Composer chooses exactly one adapter before showing provider controls', async ({
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
              displayName: 'X account',
              status: 'active',
            },
            {
              id: '00000000-0000-4000-8000-000000000202',
              provider: 'youtube',
              displayName: 'Video channel',
              status: 'active',
            },
            {
              id: '00000000-0000-4000-8000-000000000203',
              provider: 'linkedin',
              displayName: 'Member profile',
              status: 'active',
              expiresAt: '2030-01-01T00:00:00Z',
            },
            {
              id: '00000000-0000-4000-8000-000000000204',
              provider: 'meta',
              destinationProvider: 'facebook_page',
              displayName: 'Page',
              status: 'active',
              capabilitySnapshot: { contentKinds: ['link', 'single_image'] },
            },
            {
              id: '00000000-0000-4000-8000-000000000205',
              provider: 'tiktok',
              displayName: 'Creator',
              status: 'active',
            },
            {
              id: '00000000-0000-4000-8000-000000000206',
              provider: 'x',
              displayName: 'Expired account',
              status: 'reconnect_required',
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  const requests: { providerAccountIds: string[] }[] = [];
  await page.route('**/api/workflow/posts', (route) => {
    requests.push(route.request().postDataJSON() as { providerAccountIds: string[] });
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: '{"data":{"jobs":[{}]},"error":null}',
    });
  });
  await page.goto(await workspacePath(page, 'queue'));
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await expect(page.getByRole('radio', { name: /X account/ })).not.toBeChecked();
  await expect(page.getByLabel('Post body')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Expired account/ })).toBeDisabled();
  await expect(page.locator('.composer-sheet')).toHaveCSS('opacity', '1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    testInfo.project.name === 'mobile' ? 390 : 1440,
  );
  await page.screenshot({ path: testInfo.outputPath('composer-choose-account.png') });

  const choose = async (name: RegExp) => {
    const change = page.getByRole('button', { name: 'Change account' });
    if (await change.isVisible().catch(() => false)) await change.click();
    await page.getByRole('radio', { name }).click();
    await expect(page.getByRole('button', { name: 'Change account' })).toBeVisible();
  };
  await page.getByRole('radio', { name: /X account/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Change account' })).toBeFocused();
  await expect(page.getByText('Text, images, GIF or MP4 video')).toHaveCount(0);
  await expect(page.getByLabel('Post body')).toBeVisible();
  await expect(page.getByText('Up to four images, or one GIF or MP4 video')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('composer-x-selected.png') });
  await choose(/Video channel/);
  await expect(page.getByLabel('Video title')).toBeVisible();
  await expect(page.getByLabel('Visibility')).toBeVisible();
  await expect(page.getByLabel('Post body')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('composer-youtube-selected.png') });
  await choose(/Member profile/);
  await expect(page.getByLabel('Post body')).toBeVisible();
  await expect(page.locator('#composer-media-upload')).toHaveCount(0);
  await choose(/Facebook Pages · Page/);
  await expect(page.getByRole('button', { name: 'link' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'carousel' })).toHaveCount(0);
  await choose(/TikTok · Creator/);
  await expect(page.getByText('Prepared TikTok posts')).toBeVisible();
  await choose(/X account/);
  await page.getByLabel('Post body').fill('One destination only');
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeEnabled();
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
  expect(requests.map((request) => request.providerAccountIds)).toEqual([
    ['00000000-0000-4000-8000-000000000201'],
  ]);
  await page.screenshot({ path: testInfo.outputPath('composer-one-destination-success.png') });
});

test('LinkedIn member video uses one MP4 in the shared Composer on desktop and mobile', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  const accountId = '00000000-0000-4000-8000-000000000299';
  const mediaId = '00000000-0000-4000-8000-000000000298';
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: accountId,
              provider: 'linkedin',
              displayName: 'Member video profile',
              status: 'active',
              expiresAt: '2030-01-01T00:00:00Z',
              capabilitySnapshot: { contentKinds: ['text', 'link', 'video'] },
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  await page.route('**/api/workflow/media', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: mediaId }, error: null }),
    }),
  );
  let submitted:
    { content: { kind: string; text: string; title: string }; mediaIds: string[] } | undefined;
  await page.route('**/api/workflow/posts', (route) => {
    submitted = route.request().postDataJSON() as typeof submitted;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: '{"data":{"jobs":[{}]},"error":null}',
    });
  });
  await page.goto(await workspacePath(page, 'queue'));
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await selectComposerAccount(page, 'Member video profile');
  await expect(page.locator('#composer-media-upload')).toHaveCount(0);
  await page.getByRole('button', { name: 'video', exact: true }).click();
  await expect(page.getByLabel('Video title')).toBeVisible();
  await expect(page.locator('#composer-media-upload')).toHaveAttribute('accept', 'video/mp4');
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('linkedin-video-empty.png'), fullPage: true });
  await page.getByLabel('Post body').fill('Watch our member video');
  await page.getByLabel('Video title').fill('Demo');
  await page.locator('#composer-media-upload').setInputFiles({
    name: 'demo.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('fixture video'),
  });
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('linkedin-video-ready.png'), fullPage: true });
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
  await page.locator('#composer-media-upload').setInputFiles({
    name: 'demo.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('fixture video'),
  });
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
  expect(submitted?.content).toEqual({
    kind: 'video',
    text: 'Watch our member video',
    title: 'Demo',
  });
  expect(submitted?.mediaIds).toEqual([mediaId]);
});

test('LinkedIn article optionally attaches one verified image through the shared Composer', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  const mediaId = '00000000-0000-4000-8000-000000000298';
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: '00000000-0000-4000-8000-000000000299',
              provider: 'linkedin',
              displayName: 'Member article profile',
              status: 'active',
              expiresAt: '2030-01-01T00:00:00Z',
              capabilitySnapshot: { contentKinds: ['text', 'link', 'video', 'single_image'] },
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  let uploads = 0;
  await page.route('**/api/workflow/media', (route) => {
    uploads += 1;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: mediaId }, error: null }),
    });
  });
  let submitted: { content: { kind: string; linkUrl: string }; mediaIds: string[] } | undefined;
  await page.route('**/api/workflow/posts', (route) => {
    submitted = route.request().postDataJSON() as typeof submitted;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: '{"data":{"jobs":[{}]},"error":null}',
    });
  });
  await page.goto(await workspacePath(page, 'queue'));
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await selectComposerAccount(page, 'Member article profile');
  await page.getByRole('button', { name: 'Article link' }).click();
  await page.getByLabel('Post body').fill('Read the full story');
  await page.getByLabel('HTTPS link').fill('https://example.com/story');
  await page.getByLabel('Article title').fill('Full story');
  await expect(page.getByText('Optional JPEG or PNG article thumbnail')).toBeVisible();
  await page.locator('#composer-media-upload').setInputFiles({
    name: 'too-large.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(5_000_001),
  });
  await expect(
    page.getByText('One or more files exceed the destination size limit.'),
  ).toBeVisible();
  expect(uploads).toBe(0);
  await page.locator('#composer-media-upload').setInputFiles({
    name: 'thumbnail.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(100),
  });
  await page.screenshot({
    path: testInfo.outputPath('linkedin-article-thumbnail.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
  expect(submitted).toMatchObject({
    content: { kind: 'link', linkUrl: 'https://example.com/story' },
    mediaIds: [mediaId],
  });
  expect(uploads).toBe(1);
});

test('LinkedIn member image uses one JPEG or PNG in the shared Composer', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  const accountId = '00000000-0000-4000-8000-000000000299';
  const mediaId = '00000000-0000-4000-8000-000000000298';
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: accountId,
              provider: 'linkedin',
              displayName: 'Member image profile',
              status: 'active',
              expiresAt: '2030-01-01T00:00:00Z',
              capabilitySnapshot: { contentKinds: ['text', 'link', 'video', 'single_image'] },
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  let uploads = 0;
  await page.route('**/api/workflow/media', (route) => {
    uploads += 1;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: mediaId }, error: null }),
    });
  });
  let submitted: { content: { kind: string; text: string }; mediaIds: string[] } | undefined;
  await page.route('**/api/workflow/posts', (route) => {
    submitted = route.request().postDataJSON() as typeof submitted;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: '{"data":{"jobs":[{}]},"error":null}',
    });
  });
  await page.goto(await workspacePath(page, 'queue'));
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await selectComposerAccount(page, 'Member image profile');
  await page.getByRole('button', { name: 'single image', exact: true }).click();
  await expect(page.locator('#composer-media-upload')).toHaveAttribute(
    'accept',
    'image/jpeg,image/png',
  );
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
  await page.getByLabel('Post body').fill('Member image post');
  await page.locator('#composer-media-upload').setInputFiles({
    name: 'oversized.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(5_000_001),
  });
  await expect(
    page.getByText('One or more files exceed the destination size limit.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
  expect(uploads).toBe(0);
  await page.locator('#composer-media-upload').setInputFiles({
    name: 'image.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(5_000_000),
  });
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('linkedin-image-ready.png'), fullPage: true });
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
  expect(submitted).toMatchObject({
    content: { kind: 'single_image', text: 'Member image post' },
    mediaIds: [mediaId],
  });
  expect(uploads).toBe(1);
});

test('Composer separates same-name destinations by platform on desktop and mobile', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            { id: 'x-one', provider: 'x', displayName: 'Plamen Andonov', status: 'active' },
            {
              id: 'linkedin-one',
              provider: 'linkedin',
              displayName: 'Plamen Andonov',
              status: 'active',
              expiresAt: '2030-01-01T00:00:00Z',
            },
            {
              id: 'facebook-one',
              provider: 'meta',
              destinationProvider: 'facebook_page',
              displayName: 'VibeCoders.bg',
              status: 'active',
              availability: 'remote_missing',
            },
            {
              id: 'youtube-one',
              provider: 'youtube',
              displayName: 'Video channel',
              status: 'active',
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  await page.goto(await workspacePath(page, 'queue'));
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await expect(page.locator('.account-picker-platform')).toHaveText([
    'LinkedIn',
    'Facebook Pages',
    'X',
    'YouTube',
  ]);
  await expect(page.getByRole('radio', { name: /LinkedIn · Plamen Andonov/ })).toBeEnabled();
  await expect(page.getByRole('radio', { name: /X · Plamen Andonov/ })).toBeEnabled();
  await expect(page.getByRole('radio', { name: /Facebook Pages · VibeCoders.bg/ })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Reconnect' })).toBeVisible();
  await expect(page.locator('.composer-sheet')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('composer-platform-groups.png') });

  await page.getByRole('radio', { name: /LinkedIn · Plamen Andonov/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.account-picker-summary')).toContainText(
    'Posting to LinkedIn · Plamen Andonov',
  );
  await page.getByRole('button', { name: 'Change account' }).click();
  await expect(page.getByRole('radio', { name: /LinkedIn · Plamen Andonov/ })).toBeFocused();
  await page.getByRole('radio', { name: /X · Plamen Andonov/ }).click();
  await expect(page.locator('.account-picker-summary')).toContainText(
    'Posting to X · Plamen Andonov',
  );
  await page.screenshot({ path: testInfo.outputPath('composer-platform-selected.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    testInfo.project.name === 'mobile' ? 390 : 1440,
  );
});

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
  await selectComposerAccount(page, 'Instagram · @mira');
  await expect(page.getByRole('button', { name: 'carousel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'link' })).toHaveCount(0);
  await selectComposerAccount(page, 'Facebook Pages · Mira Studio');
  await expect(page.getByRole('button', { name: 'single image' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'carousel' })).toHaveCount(0);
  await expect(page.locator('.composer-body-heading')).toContainText('0/280 characters');
  await expect(page.locator('.composer-body-heading')).not.toContainText('X post');
  await page.getByRole('button', { name: 'Change account' }).click();
  await expect(page.getByText(/remote missing · reconnect to schedule/)).toBeVisible();
  await expect(page.getByText(/reauth required · reconnect to schedule/)).toBeVisible();
  await expect(page.getByText(/permission lost · reconnect to schedule/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('meta-shared-shape.png'), fullPage: true });
  await page.getByRole('button', { name: 'Keep Facebook Pages · Mira Studio' }).click();
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
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('meta-link-validation.png'), fullPage: true });
  await page.getByLabel('HTTPS link').fill('https://example.test');
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeEnabled();
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
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
      body: JSON.stringify({ data: { jobs: [{}] }, error: null }),
    });
  });
  await page.goto(await workspacePath(page, 'queue'));
  await page
    .locator('.page-heading')
    .getByRole('button', { name: /Create post/ })
    .click();
  for (const name of [
    'Instagram · @missing',
    'Facebook Pages · Unavailable Page 1',
    'Facebook Pages · Unavailable Page 2',
  ])
    await expect(
      page.locator('.account-picker label').filter({ hasText: name }).locator('input'),
    ).toBeDisabled();
  await selectComposerAccount(page, 'Instagram · @mira');
  await page.getByRole('button', { name: 'carousel' }).click();
  await page.getByPlaceholder('What should your audience know?').fill('Shared Meta image');
  const image = (name: string) => ({
    name,
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  });
  await page.locator('#composer-media-upload').setInputFiles([image('first.png')]);
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath('meta-carousel-needs-images.png'),
    fullPage: true,
  });
  await page
    .locator('#composer-media-upload')
    .setInputFiles([image('first.png'), image('second.png')]);
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeEnabled();
  await selectComposerAccount(page, 'Facebook Pages · Mira Studio');
  await expect(page.getByRole('button', { name: 'carousel' })).toHaveCount(0);
  await page.getByRole('button', { name: 'single image' }).click();
  await page.locator('#composer-media-upload').setInputFiles([image('shared.png')]);
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeEnabled();
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('meta-shared-image-success.png'),
    fullPage: true,
  });
  expect(uploadCount).toBe(1);
  expect(submitted?.content.kind).toBe('single_image');
  expect(submitted?.mediaIds).toHaveLength(1);
  expect(submitted?.providerAccountIds).toEqual(['00000000-0000-4000-8000-000000000212']);
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
  await selectComposerAccount(page, 'Example Editorial');
  await page.getByLabel('Post body').fill('Imported draft awaiting media details');
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath('external-draft-desktop.png'),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.composer-sheet')).toBeVisible();
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
  await page.screenshot({ path: testInfo.outputPath('external-draft-mobile.png'), fullPage: true });
});

test('LinkedIn text URL and explicit article stay distinct', async ({ page }, testInfo) => {
  await establishWorkspaceSession(page);
  const linkedinId = '00000000-0000-4000-8000-000000000203';
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: linkedinId,
              provider: 'linkedin',
              displayName: 'Member One',
              status: 'active',
              expiresAt: '2030-01-01T00:00:00Z',
              capabilitySnapshot: { contentKinds: ['text', 'link'] },
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  const submissions: {
    content: Record<string, string>;
    mediaIds: string[];
    key: string;
  }[] = [];
  await page.route('**/api/workflow/posts', (route) => {
    const body = route.request().postDataJSON() as {
      content: Record<string, string>;
      mediaIds: string[];
    };
    submissions.push({ ...body, key: route.request().headers()['idempotency-key'] ?? '' });
    return route.fulfill({
      status: submissions.length < 3 ? 400 : 201,
      contentType: 'application/json',
      body:
        submissions.length < 3
          ? '{"error":"Post rejected"}'
          : '{"data":{"jobs":[{}]},"error":null}',
    });
  });
  await page.goto(await workspacePath(page, 'queue'));
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await selectComposerAccount(page, 'LinkedIn · Member One');
  await expect(page.getByRole('button', { name: 'Article link' })).toBeVisible();
  await page.getByLabel('Post body').fill('https://example.com/plain-url');
  await expect(page.getByLabel('Article title')).toHaveCount(0);
  await page.getByRole('button', { name: 'Article link' }).click();
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
  await page.getByLabel('HTTPS link').fill('https://example.com/article');
  await page.getByLabel('Article title').fill('Our article');
  await page.getByLabel('Description (optional)').fill('A short preview');
  await expect(
    page.getByText('LinkedIn will use these fields for the article preview'),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('linkedin-article-ready.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect.poll(() => submissions.length).toBe(1);
  await page.getByLabel('Article title').fill('Corrected title');
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect.poll(() => submissions.length).toBe(2);
  await page.getByLabel('Description (optional)').fill('Corrected preview');
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
  expect(submissions.map((item) => item.key)).toHaveLength(3);
  expect(new Set(submissions.map((item) => item.key)).size).toBe(3);
  expect(submissions[1]?.content.title).toBe('Corrected title');
  expect(submissions[1]?.content.description).toBe('A short preview');
  expect(submissions[2]?.content).toMatchObject({
    kind: 'link',
    linkUrl: 'https://example.com/article',
    title: 'Corrected title',
    description: 'Corrected preview',
  });
  expect(submissions[2]?.mediaIds).toEqual([]);
});

test('blocks incompatible imported media after changing destination and permits removal', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  const xId = '00000000-0000-4000-8000-000000000201';
  const linkedinId = '00000000-0000-4000-8000-000000000203';
  const mediaId = '00000000-0000-4000-8000-000000000851';
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            { id: xId, provider: 'x', displayName: 'X account', status: 'active' },
            {
              id: linkedinId,
              provider: 'linkedin',
              displayName: 'LinkedIn member',
              status: 'active',
              expiresAt: '2030-01-01T00:00:00Z',
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  const draftId = '00000000-0000-4000-8000-000000000850';
  await page.route(`**/api/workflow/drafts/${draftId}`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          label: 'Imported image',
          mediaIds: [mediaId],
          media: [
            {
              id: mediaId,
              mimeType: 'image/jpeg',
              byteSize: 1024,
              durationMs: null,
              ready: true,
              previewUrl: null,
            },
          ],
          postId: null,
        },
        error: null,
      }),
    }),
  );
  let submitted: { mediaIds: string[]; providerAccountIds: string[] } | undefined;
  await page.route('**/api/workflow/posts', (route) => {
    submitted = route.request().postDataJSON() as typeof submitted;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: '{"data":{"jobs":[{}]},"error":null}',
    });
  });
  await page.goto(await workspacePath(page, `drafts/${draftId}`));
  await selectComposerAccount(page, 'X account');
  await page.getByLabel('Post body').fill('A post with media');
  const schedule = page.getByRole('button', { name: 'Schedule 1 post' });
  await expect(schedule).toBeEnabled();
  await selectComposerAccount(page, 'LinkedIn member');
  await expect(page.getByText('Imported image', { exact: true })).toBeVisible();
  await expect(page.getByText('Media is not supported for this account')).toBeVisible();
  await expect(
    page.getByText('Attached draft media is unavailable or unsupported for this destination.'),
  ).toBeVisible();
  await expect(schedule).toBeDisabled();
  expect(submitted).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('imported-media-incompatible.png') });
  await page.getByRole('button', { name: 'Remove from post' }).click();
  await expect(schedule).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('imported-media-removed.png') });
  await schedule.click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
  expect(submitted?.mediaIds).toEqual([]);
  expect(submitted?.providerAccountIds).toEqual([linkedinId]);
});

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const destination of ['Instagram · @mira', 'Facebook Pages · Mira Studio']) {
    for (const mimeType of ['image/gif', 'image/webp']) {
      test(`rejects ${mimeType} for ${destination} imported and new media at ${String(viewport.width)}px`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize(viewport);
        await establishWorkspaceSession(page);
        await mockMetaDestinations(page);
        const draftId = '00000000-0000-4000-8000-000000000850';
        const mediaId = '00000000-0000-4000-8000-000000000851';
        await page.route(`**/api/workflow/drafts/${draftId}`, (route) =>
          route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              data: {
                label: 'Imported unsupported image',
                mediaIds: [mediaId],
                media: [{ id: mediaId, mimeType, byteSize: 1024, durationMs: null, ready: true }],
                postId: null,
              },
              error: null,
            }),
          }),
        );
        let uploads = 0;
        let posts = 0;
        await page.route('**/api/workflow/media', (route) => {
          uploads += 1;
          return route.fulfill({ status: 201, body: '{"data":{"id":"new-media"}}' });
        });
        await page.route('**/api/workflow/posts', (route) => {
          posts += 1;
          return route.fulfill({ status: 201, body: '{"data":{"jobs":[{}]}}' });
        });
        await page.goto(await workspacePath(page, `drafts/${draftId}`));
        await selectComposerAccount(page, destination);
        if (destination.startsWith('Facebook'))
          await page.getByRole('button', { name: 'single image' }).click();
        await page.getByLabel('Post body').fill('Meta image post');
        const schedule = page.getByRole('button', { name: 'Schedule 1 post' });
        const input = page.locator('#composer-media-upload');
        await expect(input).toHaveAttribute('accept', 'image/jpeg,image/png');
        await expect(
          page.getByText('Attached draft media is unavailable or unsupported'),
        ).toBeVisible();
        await expect(schedule).toBeDisabled();
        await page.screenshot({ path: testInfo.outputPath('meta-imported-unsupported.png') });
        await page.getByRole('button', { name: 'Remove from post' }).click();
        await input.setInputFiles({
          name: mimeType === 'image/gif' ? 'animated.gif' : 'photo.webp',
          mimeType,
          buffer: Buffer.from('unsupported image'),
        });
        await expect(page.getByRole('alert')).toContainText('Choose a JPEG or PNG image');
        await expect(page.locator('.composer-media-attachment')).toHaveCount(0);
        await expect(schedule).toBeDisabled();
        expect(uploads).toBe(0);
        expect(posts).toBe(0);
        await page.screenshot({ path: testInfo.outputPath('meta-upload-rejected.png') });
        await input.setInputFiles({
          name: 'supported.png',
          mimeType: 'image/png',
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        });
        await expect(schedule).toBeEnabled();
      });
    }
  }
}

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
          media: [
            {
              id: '00000000-0000-4000-8000-000000000861',
              mimeType: 'image/jpeg',
              byteSize: 1024,
              durationMs: null,
              ready: true,
              previewUrl: null,
            },
          ],
          postId: null,
        },
        error: null,
      }),
    });
  });
  const path = await workspacePath(page, `drafts/${draftId}`);
  await page.goto(path);
  await selectComposerAccount(page, 'Example Editorial');
  await page.getByLabel('Post body').fill('Ready only after hydration');
  const schedule = page.getByRole('button', { name: 'Schedule 1 post' });
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
  await selectComposerAccount(page, 'Example Editorial');
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
  await expect(page.getByRole('region', { name: 'Connect your first account' })).not.toContainText(
    'Snapchat',
  );
  await expect(page.getByRole('button', { name: /^Instagram Connect an Instagram/ })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Facebook Pages Connect a Facebook Page/ }),
  ).toBeVisible();
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

test('shows an exposed Page in Accounts and Composer without origin-owned actions', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  let showPosts = true;
  let failVisibilitySave = true;
  await page.route('**/api/provider-accounts*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: route.request().url().includes('cursor=')
            ? [
                {
                  id: '00000000-0000-4000-8000-000000000310',
                  provider: 'meta',
                  destinationProvider: 'facebook_page',
                  displayName: 'Later Page',
                  status: 'active',
                  availability: 'active',
                  updatedAt: '2026-10-18T10:00:00Z',
                  adapterDefaults: {},
                  isExposed: true,
                  originWorkspaceName: '21digital',
                  showOtherWorkspacePosts: showPosts,
                },
              ]
            : [
                {
                  id: '00000000-0000-4000-8000-000000000309',
                  provider: 'meta',
                  destinationProvider: 'facebook_page',
                  displayName: 'Shared Page',
                  status: 'active',
                  availability: 'active',
                  updatedAt: '2026-10-18T10:00:00Z',
                  adapterDefaults: {},
                  isExposed: true,
                  originWorkspaceName: '21digital',
                  showOtherWorkspacePosts: showPosts,
                },
              ],
          nextCursor: route.request().url().includes('cursor=') ? null : 'test-cursor',
        },
        error: null,
      }),
    }),
  );
  await page.route(
    '**/api/provider-accounts/00000000-0000-4000-8000-000000000309/calendar-visibility',
    async (route) => {
      if (failVisibilitySave) {
        failVisibilitySave = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ data: null, error: 'Could not save calendar setting' }),
        });
        return;
      }
      const body = route.request().postDataJSON() as { showPosts: boolean };
      showPosts = body.showPosts;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { showPosts }, error: null }),
      });
    },
  );
  await page.goto(await workspacePath(page, 'accounts'));
  await expect(page.getByText('Shared from 21digital')).toBeVisible();
  const visibility = page.getByRole('switch', { name: 'Show posts from other workspaces' }).first();
  await expect(visibility).toHaveAttribute('aria-checked', 'true');
  await visibility.click();
  await expect(page.getByRole('alert')).toContainText('Could not save calendar setting');
  await expect(visibility).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({
    path: testInfo.outputPath('shared-page-calendar-error.png'),
    fullPage: true,
  });
  await visibility.click();
  await expect(visibility).toHaveAttribute('aria-checked', 'false');
  await page.screenshot({
    path: testInfo.outputPath('shared-page-calendar-hidden.png'),
    fullPage: true,
  });
  await page.reload();
  await expect(visibility).toHaveAttribute('aria-checked', 'false');
  await visibility.click();
  await expect(visibility).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'More actions for Shared Page' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revoke Meta connection' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more accounts' }).click();
  await expect(page.locator('.account-row strong', { hasText: 'Later Page' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('shared-page-accounts.png'), fullPage: true });
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('button', { name: 'Create post' }).click();
  await expect(page.getByRole('radio', { name: /Facebook Pages · Shared Page/ })).toBeVisible();
  await page.getByRole('button', { name: 'Load more accounts' }).click();
  await expect(page.getByRole('radio', { name: /Facebook Pages · Later Page/ })).toBeVisible();
});

test('lets the origin Page owner hide other-workspace calendar posts', async ({ page }) => {
  await establishWorkspaceSession(page);
  let showPosts = true;
  const accountId = '00000000-0000-4000-8000-000000000391';
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: accountId,
              provider: 'meta',
              destinationProvider: 'facebook_page',
              displayName: 'Origin Page',
              status: 'active',
              availability: 'active',
              updatedAt: '2026-10-18T10:00:00Z',
              adapterDefaults: {},
              showOtherWorkspacePosts: showPosts,
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  await page.route(`**/api/provider-accounts/${accountId}/calendar-visibility`, (route) => {
    showPosts = (route.request().postDataJSON() as { showPosts: boolean }).showPosts;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { showPosts }, error: null }),
    });
  });
  await page.goto(await workspacePath(page, 'accounts'));
  const visibility = page.getByRole('switch', { name: 'Show posts from other workspaces' });
  await expect(visibility).toHaveAttribute('aria-checked', 'true');
  await visibility.click();
  await expect(visibility).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(visibility).toHaveAttribute('aria-checked', 'false');
});

test('owner shares one Page with workspace checkboxes and sees revoke guard', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  const currentResponse = await page.request.get('/api/workspaces/current');
  const current = (await currentResponse.json()) as {
    data: { id: string; slug: string; name: string };
  };
  const accountId = '00000000-0000-4000-8000-000000000311';
  const editorialId = '00000000-0000-4000-8000-000000000312';
  const influencerId = '00000000-0000-4000-8000-000000000313';
  const selected = new Set([editorialId]);
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          workspaces: [
            { ...current.data, role: 'owner' },
            { id: editorialId, name: 'Editorial', slug: 'editorial', role: 'owner' },
            { id: influencerId, name: 'AI Influencer', slug: 'ai-influencer', role: 'owner' },
          ],
        },
        error: null,
      }),
    }),
  );
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: accountId,
              provider: 'meta',
              destinationProvider: 'facebook_page',
              displayName: 'Sneji Page',
              status: 'active',
              availability: 'active',
              adapterDefaults: {},
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  await page.route(`**/api/provider-accounts/${accountId}/exposures`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: { workspaceIds: [...selected], nextCursor: null },
        error: null,
      }),
    }),
  );
  await page.route(`**/api/provider-accounts/${accountId}/exposures/*`, async (route) => {
    const target = route.request().url().split('/').at(-1);
    if (target === editorialId) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          data: null,
          error: 'Resolve scheduled jobs before hiding this Page from the workspace',
        }),
      });
      return;
    }
    selected.add(influencerId);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { exposed: true }, error: null }),
    });
  });
  await page.goto(`/w/${current.data.slug}/accounts`);
  await page.getByRole('button', { name: 'Share with workspaces' }).click();
  const editorial = page.getByRole('checkbox', { name: 'Editorial' });
  const influencer = page.getByRole('checkbox', { name: 'AI Influencer' });
  await expect(editorial).toHaveAttribute('aria-checked', 'true');
  await expect(influencer).toHaveAttribute('aria-checked', 'false');
  await influencer.click();
  await expect(influencer).toHaveAttribute('aria-checked', 'true');
  await editorial.click();
  await expect(page.getByRole('alert')).toContainText('Resolve scheduled jobs');
  await expect(editorial).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({
    path: testInfo.outputPath('page-exposure-checkboxes.png'),
    fullPage: true,
  });
  await page.reload();
  await page.getByRole('button', { name: 'Share with workspaces' }).click();
  await expect(page.getByRole('checkbox', { name: 'AI Influencer' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
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
  await expect(page.locator('.adapter-picker-option').last()).toBeFocused();
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
  await page.route('**/api/provider-accounts*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts:
            route.request().url().includes('provider=linkedin') &&
            !route.request().url().includes('cursor=')
              ? []
              : [
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
          nextCursor:
            route.request().url().includes('provider=linkedin') &&
            !route.request().url().includes('cursor=')
              ? 'next-linkedin-page'
              : null,
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
  await selectComposerAccount(page, 'Member One');
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
    'Any previously usable Instagram account remains available',
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

test('Instagram Login shows safe errors and a connected but non-publishable account on both viewports', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await page.goto('/app?oauth=instagram-no-account&code=secret-code');
  await expect(page.getByRole('alert')).toContainText('No eligible Instagram Professional account');
  await expect(page.getByRole('alert')).not.toContainText('secret-code');
  await page.screenshot({
    path: testInfo.outputPath('instagram-login-error-desktop.png'),
    fullPage: true,
  });
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: '00000000-0000-4000-8000-000000000909',
              provider: 'instagram_login',
              destinationProvider: 'instagram',
              displayName: 'bitcoinbarbulgaria',
              status: 'active',
              availability: 'publishing_unavailable',
              updatedAt: '2026-10-09T11:00:00Z',
              adapterDefaults: {},
            },
          ],
        },
        error: null,
      }),
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app?oauth=instagram-connected');
  await expect(
    page.locator('.account-row').filter({ hasText: 'bitcoinbarbulgaria' }),
  ).toContainText('Instagram is connected. Publishing is not yet available');
  await page.screenshot({
    path: testInfo.outputPath('instagram-login-connected-mobile.png'),
    fullPage: true,
  });
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
  await page.route('**/api/oauth/instagram', (route) => {
    starts.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: 'Instagram Login is not configured yet' }),
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
  await expect(page.getByRole('alert')).toContainText('Instagram Login is not configured yet');
  expect(starts).toEqual(['/api/oauth/meta/facebook-pages', '/api/oauth/instagram']);
});

test('LinkedIn health failure emits one anonymous connection error', async ({ page }) => {
  await watchErrorHooks(page);
  await establishWorkspaceSession(page);
  await page.route('**/api/provider-accounts?*', (route) =>
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
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'publish_relay_csrf',
  )?.value;
  const created = await page.request.post('/api/workspaces', {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: { name: 'Relay' },
  });
  expect(created.ok()).toBe(true);
  const target = (await created.json()) as { data: { id: string; slug: string } };
  await page.goto(await workspacePath(page, 'accounts'));
  if ((page.viewportSize()?.width ?? 0) < 768)
    await page.getByRole('button', { name: 'Open navigation' }).click();
  const trigger = page.locator('.workspace-switcher');
  await trigger.click();
  const search = page.getByRole('combobox', { name: 'Search workspaces' });
  await expect(search).toBeFocused();
  await search.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await search.press('End');
  await expect(search).toHaveAttribute(
    'aria-activedescendant',
    `workspace-option-${target.data.id}`,
  );
  await search.press('Enter');
  await expect(page).toHaveURL(`/w/${target.data.slug}/accounts`);
  await expect(
    page.getByText('Manage publishing access and connection health for Relay.'),
  ).toBeVisible();
  const current = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { id: string };
  };
  expect(current.data.id).toBe(target.data.id);
  if ((page.viewportSize()?.width ?? 0) < 768)
    await page.getByRole('button', { name: 'Open navigation' }).click();
  const switchedTrigger = page.locator('.workspace-switcher');
  await switchedTrigger.click();
  await expect(page.getByRole('link', { name: 'Add new workspace' })).toHaveAttribute(
    'href',
    `/w/${target.data.slug}/settings/workspace`,
  );
});

test('direct workspace links cannot mislabel the active session, but the switcher changes it', async ({
  page,
}) => {
  await establishWorkspaceSession(page);
  const current = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { id: string; slug: string };
  };
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'publish_relay_csrf',
  )?.value;
  const created = await page.request.post('/api/workspaces', {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: { name: 'Second workspace' },
  });
  expect(created.ok()).toBe(true);
  const target = (await created.json()) as { data: { id: string; slug: string } };

  await page.goto(`/w/${target.data.slug}/calendar?mode=Week&date=2026-10-25`);
  await expect(page).toHaveURL(`/w/${current.data.slug}/calendar?mode=Week&date=2026-10-25`);
  await expect(page.locator('.workspace-switcher')).toContainText('Atlas');
  const stillCurrent = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { id: string };
  };
  expect(stillCurrent.data.id).toBe(current.data.id);

  if ((page.viewportSize()?.width ?? 0) < 768)
    await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('.workspace-switcher').click();
  await page.getByRole('option', { name: /Second workspace/ }).click();
  await expect(page).toHaveURL(`/w/${target.data.slug}/accounts`);
  const switched = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { id: string };
  };
  expect(switched.data.id).toBe(target.data.id);
  if ((page.viewportSize()?.width ?? 0) < 768)
    await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('.workspace-switcher')).toContainText('Second workspace');

  await page.goto(`/w/${current.data.slug}/jobs/not-a-local-job`);
  await expect(page).toHaveURL(`/w/${target.data.slug}/jobs/not-a-local-job`);
});

test('keeps workspace creation reachable when search has no matches', async ({ page }) => {
  await establishWorkspaceSession(page);
  await page.goto(await workspacePath(page, 'accounts'));
  if ((page.viewportSize()?.width ?? 0) < 768)
    await page.getByRole('button', { name: 'Open navigation' }).click();
  const trigger = page.locator('.workspace-switcher');
  await trigger.click();
  const search = page.getByRole('combobox', { name: 'Search workspaces' });
  await search.fill('no workspace matches this query');
  await expect(page.getByRole('listbox', { name: 'Workspaces' }).getByRole('option')).toHaveCount(
    0,
  );
  const addWorkspace = page.getByRole('link', { name: 'Add new workspace' });
  await expect(addWorkspace).toBeVisible();
  await search.press('Tab');
  await expect(addWorkspace).toBeFocused();
  await addWorkspace.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await addWorkspace.click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/settings\/workspace$/);
  await expect(page.getByRole('heading', { name: 'Manage workspaces' })).toBeVisible();
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
  await selectComposerAccount(page, 'Example Editorial');
  await expect(page.getByLabel('Post body')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('composer.png'), fullPage: true });
  await expect(page.getByText('Choose files')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
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
  ).toEqual(new Set(['00000000-0000-4000-8000-000000000201']));
  await scheduleDate.fill('2020-01-01');
  await scheduleTime.fill('09:00');
  await expect(page.getByRole('alert')).toContainText('future publishing time');
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
  await scheduleDate.fill('2026-09-01');
  await scheduleTime.fill('10:05');
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeEnabled();
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect(page.getByRole('alert')).toContainText('Retry safely');
  await page.getByRole('button', { name: 'Confirm previous request' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
  expect(createHeaders?.['x-csrf-token']).toBeTruthy();
  expect(createHeaders?.['idempotency-key']).toBeTruthy();
  expect(createHeaders?.['idempotency-key']).toBe(firstCreateHeaders?.['idempotency-key']);
  expect(createPayload).toMatchObject({
    content: { type: 'text', text: 'A clear publishing update for two accounts.' },
    providerAccountIds: ['00000000-0000-4000-8000-000000000201'],
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
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Retry safely' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Keep job' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry now' })).toBeFocused();
  await page.getByRole('button', { name: 'Retry now' }).click();
  await page.screenshot({ path: testInfo.outputPath('job-retry-confirm.png'), fullPage: true });
  await page.getByRole('button', { name: 'Retry safely' }).click();
  await expect(page.getByText('Retry service unavailable', { exact: true })).toBeVisible();
  expect(
    (await errorHooks(page)).filter((event) => event.properties.area === 'publishing'),
  ).toEqual([
    { type: 'user_error_shown', properties: { area: 'publishing', category: 'provider' } },
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
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Cancel job', exact: true }).last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Keep job' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job', exact: true }).first()).toBeFocused();
  await page.getByRole('button', { name: 'Cancel job', exact: true }).first().click();
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
  await selectComposerAccount(page, 'Example Editorial');
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
  await selectComposerAccount(page, 'Example Editorial');
  await dialog.getByText('Add media', { exact: true }).click();
  await expect(dialog).toBeVisible();
  if (testInfo.project.name === 'desktop') {
    await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await selectComposerAccount(page, 'Example Editorial');
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
  await selectComposerAccount(page, 'Example Editorial');
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
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
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
  await selectComposerAccount(page, 'Example Editorial');
  await page.getByLabel('Post body').fill('Two image retry');
  await page.locator('#composer-media-upload').setInputFiles(
    ['one.png', 'two.png'].map((name) => ({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    })),
  );
  const schedule = page.getByRole('button', { name: 'Schedule 1 post' });
  await schedule.click();
  await expect(page.getByRole('alert')).toContainText('Upload unavailable');
  expect(deleted).toHaveLength(1);
  await schedule.click();
  await expect(page.getByRole('alert')).toContainText('Post rejected');
  expect(deleted).toHaveLength(3);
  await schedule.click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
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
    await selectComposerAccount(page, 'Example Editorial');
    await page.getByLabel('Post body').fill('Image A');
    const input = page.locator('#composer-media-upload');
    await input.setInputFiles({
      name: 'image.png',
      mimeType: 'image/png',
      buffer: Buffer.from('image A'),
    });
    await page.getByRole('button', { name: 'Schedule 1 post' }).click();
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
    await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(uploads[0]?.bytes).toBe(Buffer.from('image A').toString('hex'));
    await page.getByRole('button', { name: 'Close composer' }).click();
    await page.getByRole('button', { name: 'Create post' }).last().click();
    await selectComposerAccount(page, 'Example Editorial');
    await page.getByLabel('Post body').fill('Image B');
    await page.locator('#composer-media-upload').setInputFiles({
      name: 'image.png',
      mimeType: 'image/png',
      buffer: Buffer.from('image B'),
    });
    await page.getByRole('button', { name: 'Schedule 1 post' }).click();
    await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
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
  await selectComposerAccount(page, 'Example Editorial');
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
    await selectComposerAccount(page, 'Standard account');
    const body = page.getByPlaceholder('What should your audience know?');
    const heading = page.locator('.composer-body-heading');
    const submit = page.getByRole('button', { name: 'Schedule 1 post' });
    await body.fill('a'.repeat(281));
    await expect(heading).toContainText('281/280 weighted characters');
    await expect(submit).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('280 weighted-character limit');
    await page.screenshot({ path: testInfo.outputPath(`x-mixed-${label}.png`), fullPage: true });
    await selectComposerAccount(page, 'Long account');
    await expect(heading).toContainText('281/25000 weighted characters');
    await expect(page.getByText('Long-post access is self-declared, not verified.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeEnabled();
    await body.fill('a'.repeat(25_000));
    await expect(heading).toContainText('25000/25000 weighted characters');
    await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeEnabled();
    await body.fill('a'.repeat(25_001));
    await expect(heading).toContainText('25001/25000 weighted characters');
    await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
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
  await selectComposerAccount(page, 'Relay Channel');
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
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
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
  await selectComposerAccount(page, 'Example Editorial');
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
  await page.route('**/api/workflow/jobs?*', async (route) => {
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
  await expect(page.getByRole('status', { name: 'Loading publication queue' })).toBeVisible();
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

  await page.unroute('**/api/workflow/jobs?*');
  await page.route('**/api/workflow/jobs?*', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"data":{"items":[]},"error":null}' }),
  );
  await page.reload();
  await expect(page).toHaveURL(/q=no-match/);
  await expect(page.getByText('No jobs match these filters')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByText('Nothing scheduled yet')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('queue-empty.png'), fullPage: true });

  await page.unroute('**/api/workflow/jobs?*');
  await page.route('**/api/workflow/jobs?*', (route) =>
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
  const activePath = await workspacePath(page, 'calendar?mode=Week&date=2026-09-01');
  const activeSlug = activePath.split('/')[2] ?? '';
  await page.route('**/api/workspaces/current', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: '{"data":{"id":"workspace-1","name":"Avery Studio","slug":"avery-studio","timezone":"Europe/Sofia"},"error":null}',
    }),
  );
  await page.route('**/api/workflow/calendar/exposed-pages?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: '{"data":{"items":[],"next":null},"error":null}',
    }),
  );
  await page.route('**/api/workflow/jobs?*', async (route) => {
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
  await page.goto(activePath);
  await expect(page.getByRole('status', { name: 'Loading publication calendar' })).toBeVisible();
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
    `/w/${activeSlug}/jobs/avery-morning`,
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
  await expect(morning).toHaveAttribute('style', /top: 397\.75px/);
  await expect(lunch).toHaveAttribute('style', /top: 408\.5px/);
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
    `/w/${activeSlug}/jobs/avery-morning`,
  );
  await page.screenshot({ path: testInfo.outputPath('calendar-timeline.png'), fullPage: true });

  await page.unroute('**/api/workflow/jobs?*');
  await page.route('**/api/workflow/jobs?*', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"data":{"items":[]},"error":null}' }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: '0 accounts' })).toBeVisible();
  await expect(page.locator('.timeline-calendar')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('calendar-empty.png'), fullPage: true });

  await page.unroute('**/api/workflow/jobs?*');
  await page.route('**/api/workflow/jobs?*', (route) =>
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

test('shows a shared Page once in the calendar with read-only origin detail', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/workspaces/current', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: '{"data":{"id":"workspace-1","name":"AI Influencer","slug":"ai-influencer","timezone":"Europe/Sofia"},"error":null}',
    }),
  );
  await page.route('**/api/workflow/jobs?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: '{"data":{"items":[]},"error":null}',
    }),
  );
  let sawDstDayWindow = false;
  await page.route('**/api/workflow/calendar/exposed-pages?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const startsAt = query.get('startsAt') ?? '';
    const endsAt = query.get('endsAt') ?? '';
    expect(Date.parse(startsAt)).toBeLessThanOrEqual(Date.parse('2026-10-25T01:30:00Z'));
    expect(Date.parse(endsAt)).toBeGreaterThan(Date.parse('2026-10-25T01:30:00Z'));
    if (startsAt === '2026-10-24T21:00:00.000Z') {
      expect(endsAt).toBe('2026-10-25T22:00:00.000Z');
      sawDstDayWindow = true;
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: [
            {
              id: '00000000-0000-4000-8000-000000000711',
              providerAccountId: '00000000-0000-4000-8000-000000000712',
              providerAccountName: 'Sneji Eli Geri',
              originWorkspaceName: '21digital',
              state: 'scheduled',
              scheduledAt: '2026-10-25T01:30:00.000Z',
              contentPreview: 'Shared caption',
              mediaCount: 1,
            },
            {
              id: '00000000-0000-4000-8000-000000000713',
              providerAccountId: '00000000-0000-4000-8000-000000000714',
              providerAccountName: 'Second Page',
              originWorkspaceName: 'Other workspace',
              state: 'scheduled',
              scheduledAt: '2026-10-25T02:00:00.000Z',
              contentPreview: 'Another Page post',
              mediaCount: 0,
            },
          ],
          next: null,
        },
        error: null,
      }),
    });
  });
  await page.route(
    '**/api/workflow/calendar/exposed-pages/00000000-0000-4000-8000-000000000711',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: '00000000-0000-4000-8000-000000000711',
            providerAccountName: 'Sneji Eli Geri',
            originWorkspaceName: '21digital',
            state: 'scheduled',
            scheduledAt: '2026-10-25T01:30:00.000Z',
            caption: 'Shared caption',
            linkUrl: null,
            media: [{ id: 'media-1', position: 0, previewUrl: null }],
          },
          error: null,
        }),
      }),
  );
  await page.goto('/w/ai-influencer/calendar?mode=Day&date=2026-10-25');
  await expect(
    page.getByRole('link', { name: /Sneji Eli Geri, Scheduled.*from 21digital/ }),
  ).toHaveCount(1);
  await expect(page.locator('.calendar-block.mirrored .calendar-origin-badge').first()).toHaveText(
    'From 21digital',
  );
  await expect(page.locator('.calendar-block.mirrored .calendar-origin-badge').first()).toHaveCSS(
    'background-color',
    'rgb(163, 255, 79)',
  );
  expect(sawDstDayWindow).toBe(true);
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(
    page
      .getByRole('gridcell', { name: /Sunday, October 25, 2026/ })
      .getByRole('link', { name: /Sneji Eli Geri, Scheduled.*from 21digital/ }),
  ).toHaveCount(1);
  const monthCard = page
    .getByRole('gridcell', { name: /Sunday, October 25, 2026/ })
    .getByRole('link', { name: /Sneji Eli Geri, Scheduled.*from 21digital/ });
  await expect(monthCard).toHaveClass(/mirrored/);
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await expect(monthCard).toHaveCSS('border-left-color', 'rgb(163, 255, 79)');
  } else {
    await expect(monthCard.locator('.calendar-origin-badge')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(
    page.getByRole('link', { name: /Sneji Eli Geri, Scheduled.*from 21digital/ }),
  ).toHaveCount(1);
  await expect(page.locator('.calendar-block.mirrored .calendar-origin-badge').first()).toHaveText(
    'From 21digital',
  );
  if ((page.viewportSize()?.width ?? 0) < 768) {
    for (const badge of await page
      .locator('.calendar-block.mirrored .calendar-origin-badge')
      .all()) {
      const geometry = await badge.evaluate((element) => ({
        visibleWidth: element.clientWidth,
        contentWidth: element.scrollWidth,
        visibleHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      }));
      expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.visibleWidth);
      expect(geometry.contentHeight).toBeLessThanOrEqual(geometry.visibleHeight);
    }
  }
  await page.screenshot({
    path: testInfo.outputPath('mirrored-calendar-week.png'),
    fullPage: true,
  });
  if ((page.viewportSize()?.width ?? 0) < 768) {
    const secondBadge = page.locator('.calendar-block.mirrored .calendar-origin-badge').nth(1);
    await secondBadge.evaluate((element) => {
      element.scrollIntoView({ block: 'nearest' });
    });
    const rightEdge = await secondBadge.evaluate(
      (element) => element.getBoundingClientRect().right,
    );
    expect(rightEdge).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
    await page.screenshot({
      path: testInfo.outputPath('mirrored-calendar-week-scrolled.png'),
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(page.locator('.timeline-job.mirrored .calendar-origin-badge').first()).toHaveText(
    'From 21digital',
  );
  await expect(page.locator('.timeline-lane')).toHaveCount(2);
  await expect(page.locator('.timeline-lane').nth(0)).toContainText('Sneji Eli Geri');
  await expect(page.locator('.timeline-lane').nth(1)).toContainText('Second Page');
  await page.getByRole('button', { name: 'Day', exact: true }).click();
  await expect(page.getByRole('link', { name: /Second Page, Scheduled/ })).toBeVisible();
  const card = page.getByRole('link', { name: /Sneji Eli Geri, Scheduled.*from 21digital/ });
  await expect(card).toHaveCount(1);
  await card.focus();
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute(
    'href',
    /calendar\/exposed-pages\/00000000-0000-4000-8000-000000000711/,
  );
  await card.click();
  await expect(page.getByRole('heading', { name: 'Sneji Eli Geri' })).toBeVisible();
  await expect(page.getByText('From 21digital · Read-only in this workspace')).toBeVisible();
  await expect(page.getByText('Shared caption')).toBeVisible();
  await expect(page.getByRole('button', { name: /edit|cancel|retry/i })).toHaveCount(0);
  await page.unroute('**/api/workflow/calendar/exposed-pages/00000000-0000-4000-8000-000000000711');
  await page.route(
    '**/api/workflow/calendar/exposed-pages/00000000-0000-4000-8000-000000000711',
    (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: '{"data":null,"error":"Job was not found"}',
      }),
  );
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Job was not found');
  await expect(page.getByText('Shared caption')).toHaveCount(0);
});

test('paginates an older calendar week past 100 local jobs and deduplicates the shared Page', async ({
  page,
}) => {
  await establishWorkspaceSession(page);
  let targetWorkspace = false;
  let secondPageRequests = 0;
  await page.route('**/api/workspaces/current', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: { name: targetWorkspace ? 'AI Influencer' : '21digital', timezone: 'Europe/Sofia' },
        error: null,
      }),
    }),
  );
  const pageJob = {
    id: '00000000-0000-4000-8000-000000000811',
    state: 'scheduled',
    scheduledAt: '2026-10-20T08:00:00.000Z',
    contentPreview: 'Older Page post',
    providerAccount: {
      id: '00000000-0000-4000-8000-000000000812',
      displayName: 'Sneji Eli Geri',
      handle: 'sneji',
      provider: 'facebook',
    },
  };
  const laterJobs = Array.from({ length: 100 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    state: 'scheduled',
    scheduledAt: `2026-10-21T${String(23 - Math.floor(index / 6)).padStart(2, '0')}:${String(
      59 - (index % 6) * 10,
    ).padStart(2, '0')}:00.000Z`,
    contentPreview: `Later job ${String(index)}`,
    providerAccount: { displayName: 'Other account', handle: 'other', provider: 'x' },
  }));
  const latestJob = laterJobs[0];
  const lastJob = laterJobs.at(-1);
  if (!latestJob || !lastJob) throw new Error('Calendar fixture requires local jobs');
  await page.route('**/api/workflow/jobs?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const containsOlderWeek =
      Date.parse(query.get('scheduledAfter') ?? '') <= Date.parse(pageJob.scheduledAt) &&
      Date.parse(query.get('scheduledBefore') ?? '') >= Date.parse(latestJob.scheduledAt);
    const items =
      targetWorkspace || !containsOlderWeek ? [] : query.has('beforeId') ? [pageJob] : laterJobs;
    if (query.has('beforeId')) secondPageRequests += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items,
          next:
            items === laterJobs
              ? { beforeScheduledAt: lastJob.scheduledAt, beforeId: lastJob.id }
              : null,
        },
        error: null,
      }),
    });
  });
  await page.route('**/api/workflow/calendar/exposed-pages?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const includesPage =
      Date.parse(query.get('startsAt') ?? '') <= Date.parse(pageJob.scheduledAt) &&
      Date.parse(query.get('endsAt') ?? '') >= Date.parse(pageJob.scheduledAt);
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: includesPage
            ? [
                {
                  id: pageJob.id,
                  providerAccountId: pageJob.providerAccount.id,
                  providerAccountName: 'Sneji Eli Geri',
                  originWorkspaceName: targetWorkspace ? '21digital' : 'AI Influencer',
                  state: 'scheduled',
                  scheduledAt: pageJob.scheduledAt,
                  contentPreview: pageJob.contentPreview,
                  mediaCount: 0,
                },
              ]
            : [],
          next: null,
        },
        error: null,
      }),
    });
  });
  await page.goto('/w/21digital/calendar?mode=Week&date=2026-10-26');
  await page.getByRole('button', { name: 'Previous date' }).click();
  await expect(page.getByRole('link', { name: /Sneji Eli Geri, Scheduled/ })).toHaveCount(1);
  expect(secondPageRequests).toBeGreaterThan(0);
  await expect(page.getByRole('link', { name: /Other account, Scheduled/ })).toHaveCount(100);
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(page.getByRole('link', { name: /Sneji Eli Geri, Scheduled/ })).toHaveCount(1);

  targetWorkspace = true;
  await page.goto('/w/ai-influencer/calendar?mode=Week&date=2026-10-20');
  await expect(
    page.getByRole('link', { name: /Sneji Eli Geri, Scheduled.*from 21digital/ }),
  ).toHaveCount(1);
  await expect(page.getByRole('link', { name: /Other account, Scheduled/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(
    page.getByRole('link', { name: /Sneji Eli Geri, Scheduled.*from 21digital/ }),
  ).toHaveCount(1);
});

test('uses Page-wide occupancy only as advisory Composer guidance', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-18T05:00:00.000Z'));
  await establishWorkspaceSession(page);
  await mockMetaDestinations(page);
  await page.route('**/api/workflow/jobs?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: '{"data":{"items":[],"next":null},"error":null}',
    }),
  );
  const occupancyCalls: string[] = [];
  await page.route(
    '**/api/workflow/accounts/00000000-0000-4000-8000-000000000212/occupancy?*',
    (route) => {
      occupancyCalls.push(route.request().url());
      return route.fulfill({
        contentType: 'application/json',
        body: '{"data":{"items":[{"scheduledAt":"2026-10-19T05:30:00.000Z","jobCount":2}],"next":null},"error":null}',
      });
    },
  );
  await page.goto(await workspacePath(page, 'queue'));
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await selectComposerAccount(page, 'Facebook Pages · Mira Studio');
  await page.getByLabel('Post body').fill('Intentional shared Page slot');
  await page.getByLabel('HTTPS link').fill('https://example.test/page');
  await page.getByLabel('Date', { exact: true }).fill('2026-10-19');
  await page.getByLabel('Time', { exact: true }).fill('08:30');
  await expect(page.getByText('2 nearby publications detected')).toBeVisible();
  await expect(page.getByText('keep the exact minute intentionally')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeEnabled();
  expect(occupancyCalls.length).toBeGreaterThan(0);
  expect(new URL(occupancyCalls.at(-1) ?? '').searchParams.get('startsAt')).toBe(
    '2026-10-19T05:15:00.000Z',
  );
});

test('refreshes background publication outcomes without replaying historical toasts', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  const activeSlug = (await workspacePath(page, 'queue')).split('/')[2] ?? '';
  await page.clock.install();
  let state = 'scheduled';
  let polls = 0;
  await page.route('**/api/workflow/jobs?*', (route) => {
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
  await page.goto(`/w/${activeSlug}/calendar?mode=Week&date=2026-10-01`);
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
  await page.goto(`/w/${activeSlug}/queue`);
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
  ).toHaveAttribute('href', `/w/${activeSlug}/jobs/outcome-job`);
});

test('shows published jobs as success across calendar modes after reload', async ({ page }) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/workflow/jobs?*', (route) =>
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

test('keeps late immediate publications inside the Week and Day calendar grid', async ({
  page,
}) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/workflow/jobs?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: [
            {
              id: 'late-published-job',
              state: 'published',
              scheduledAt: '2026-10-19T21:15:00Z',
              contentPreview: 'Evening Facebook post',
              providerAccount: { displayName: 'Evening Page', handle: '', provider: 'meta' },
            },
            {
              id: 'last-minute-published-job',
              state: 'published',
              scheduledAt: '2026-10-19T23:59:00Z',
              contentPreview: 'Last-minute Facebook post',
              providerAccount: { displayName: 'Night Page', handle: '', provider: 'meta' },
            },
          ],
          next: null,
        },
        error: null,
      }),
    }),
  );
  await page.goto(await workspacePath(page, 'calendar?mode=Week&date=2026-10-19'));
  for (const mode of ['Week', 'Day'] as const) {
    if (mode === 'Day') await page.getByRole('button', { name: 'Day', exact: true }).click();
    const grid = page.locator('.time-grid');
    await expect(grid).toBeVisible();
    const published = page.locator('.calendar-block.published');
    await expect(published).toHaveCount(2);
    await expect(published.nth(0)).toHaveAttribute(
      'aria-label',
      /Evening Page, Published.*09:15 PM UTC/,
    );
    await expect(published.nth(1)).toHaveAttribute(
      'aria-label',
      /Night Page, Published.*11:59 PM UTC/,
    );
    for (let index = 0; index < 2; index += 1) {
      await expect
        .poll(async () => {
          const gridBox = await grid.boundingBox();
          const blockBox = await published.nth(index).boundingBox();
          return Boolean(
            gridBox && blockBox && blockBox.y + blockBox.height <= gridBox.y + gridBox.height,
          );
        })
        .toBe(true);
    }
  }
});

test('navigates calendar months across month-end and leap-year boundaries', async ({ page }) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/workflow/jobs?*', (route) =>
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
  let workspaceDeleteRequests = 0;
  let keys: Record<string, unknown>[] = [];
  const eligibleCapabilities = [
    'destinations:read',
    'schedules:read',
    'schedules:write',
    'content:write',
    'publishes:submit',
    'publishes:retry',
    'audit:read',
  ];
  let workspaces = [
    { id: 'workspace-1', name: 'Atlas', slug: 'atlas', role: 'owner', position: 0 },
    { id: 'workspace-2', name: 'Relay', slug: 'relay', role: 'owner', position: 1 },
  ];
  let failNextKeyListRefresh = false;
  let forceEditConflict = false;
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
  await page.route('**/api/workspaces/workspace-3', async (route) => {
    workspaceDeleteRequests += 1;
    if (workspaceDeleteRequests === 1) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: '{"data":null,"error":"Workspace has connected accounts or provider data"}',
      });
      return;
    }
    workspaces = workspaces.filter((item) => item.id !== 'workspace-3');
    await route.fulfill({
      contentType: 'application/json',
      body: '{"data":{"deleted":true},"error":null}',
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
          capabilityVersion: 1,
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
    if (route.request().method() === 'PATCH') {
      const input = route.request().postDataJSON() as {
        capabilities: string[];
        expectedVersion: number;
      };
      const key = keys[0];
      if (forceEditConflict || input.expectedVersion !== key?.capabilityVersion) {
        forceEditConflict = false;
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: '{"data":null,"error":"API key changed or was revoked"}',
        });
        return;
      }
      keys = [
        { ...key, capabilities: input.capabilities, capabilityVersion: input.expectedVersion + 1 },
      ];
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { updated: true, capabilityVersion: input.expectedVersion + 1 },
          error: null,
        }),
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
      body: JSON.stringify({ data: { items: keys, eligibleCapabilities }, error: null }),
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
  const newDeskRow = page.locator('.workspace-management-row').filter({ hasText: 'New Desk' });
  await expect(
    page
      .locator('.workspace-management-row')
      .filter({ hasText: 'Atlas' })
      .getByRole('button', { name: 'Delete' }),
  ).toBeDisabled();
  await newDeskRow.getByRole('button', { name: 'Delete' }).click();
  await page.screenshot({
    path: testInfo.outputPath('workspace-delete-confirmation.png'),
    fullPage: true,
  });
  await expect(page.getByRole('button', { name: 'Delete workspace' })).toBeDisabled();
  await page.getByLabel('Type New Desk to confirm').fill('New Desk');
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Workspace has connected accounts or provider data',
  );
  await page.screenshot({
    path: testInfo.outputPath('workspace-delete-blocked.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  await expect(newDeskRow).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('New Desk', { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('workspace-delete-reloaded.png'),
    fullPage: true,
  });
  expect(workspaceDeleteRequests).toBe(2);
  await page.getByLabel('Name', { exact: true }).fill('Atlas Studio');
  await page.getByRole('button', { name: 'Save workspace' }).click();
  await expect(page.getByRole('status')).toContainText('Workspace settings saved');
  await page.getByRole('link', { name: 'Automation' }).click();
  await expect(page.locator('.advanced-capabilities .capability-button.active')).toHaveCount(7);
  await page.getByLabel('Key name').fill('Agent key');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByRole('button', { name: 'Creating key…' })).toBeDisabled();
  await expect(page.getByText('pr_new.one-time-secret')).toBeVisible();
  expect(createRequests).toBe(1);
  await expect(page.getByText('Created by Avery', { exact: false })).toBeVisible();
  await expect(page.getByText('Created 9/1/2026')).toBeVisible();
  await expect(page.getByText('Expires never')).toBeVisible();
  await expect(page.getByText('Capabilities:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Edit permissions' }).click();
  await page
    .locator('.api-key-permission-editor .capability-button')
    .filter({ hasText: 'audit:read' })
    .click();
  await page.screenshot({ path: testInfo.outputPath('settings-key-edit.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await expect(page.locator('.form-summary[role="status"]')).toContainText(
    'API key permissions saved',
  );
  await page.reload();
  await expect(page.locator('.api-key-row')).toContainText('publishes:retry');
  await expect(page.locator('.api-key-row')).not.toContainText('audit:read');
  await page.getByRole('button', { name: 'Edit permissions' }).click();
  forceEditConflict = true;
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await expect(page.locator('.form-summary[role="status"]')).toContainText(
    'API key changed or was revoked',
  );
  await expect(page.locator('.api-key-permission-editor')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('settings-key-conflict.png'), fullPage: true });
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
  const activeSlug = (await workspacePath(page, 'queue')).split('/')[2] ?? '';
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
  await page.goto(`/w/${activeSlug}/jobs/pending-job`);
  await expect(page.getByRole('status')).toContainText('Loading publication job');
  await expect(page.getByRole('heading', { name: 'Avery Editorial' })).toBeVisible();
  await expect(page.getByText('Provider processing', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Opening post')).toBeVisible();
  await expect(page.getByText('Closing post')).toBeVisible();
  await expect(page.getByText('API key · Editorial agent')).toBeVisible();
  await expect(page.getByText(/Media 1 unavailable/)).toBeVisible();
  await expect(page.getByText('Delivery attempt 1')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View post' })).toBeHidden();
  await page.route('**/api/workflow/jobs/published-fb', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 'published-fb',
          postId: 'facebook-post',
          state: 'published',
          scheduledAt: '2026-09-01T09:30:00+03:00',
          content: { kind: 'text', text: 'Facebook Page post' },
          media: [],
          activity: [],
          attempts: [],
          providerResult: { id: 'page_123', url: 'https://www.facebook.com/page/posts/123' },
          providerAccount: { displayName: 'Avery Page', provider: 'facebook_page' },
        },
        error: null,
      }),
    }),
  );
  await page.goto(`/w/${activeSlug}/jobs/published-fb`);
  await expect(page.getByRole('link', { name: 'View post' })).toHaveAttribute(
    'href',
    'https://www.facebook.com/page/posts/123',
  );
  await expect(page.getByRole('link', { name: /Back to queue/ })).toHaveAttribute(
    'href',
    `/w/${activeSlug}/queue`,
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
  await page.goto(`/w/${activeSlug}/jobs/pending-job`);
  await expect(page.getByRole('alert')).toContainText('Job missing');
  await expect(page.getByRole('link', { name: 'Back to queue' })).toHaveAttribute(
    'href',
    `/w/${activeSlug}/queue`,
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
      await selectComposerAccount(page, 'Example Editorial');
      await page.getByLabel('Post body').fill(`DST choice ${offsetLabel}`);
      await page.getByLabel('Date', { exact: true }).fill('2027-03-28');
      await page.getByLabel('Time', { exact: true }).fill('03:30');
      await expect(page.getByRole('alert')).toContainText('clock changes');
      await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
      await page.getByLabel('Date', { exact: true }).fill('2027-10-31');
      await expect(page.getByText('This time occurs twice')).toBeVisible();
      await page.getByRole('radio', { name: offsetLabel, exact: true }).check();
      await page.getByRole('button', { name: 'Schedule 1 post' }).click();
      await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
      await page.getByRole('button', { name: 'Close composer' }).click();
    };

    await scheduleFold('UTC+03:00');
    await scheduleFold('UTC+02:00');
    expect(persistedSchedules).toEqual(['2027-10-31T00:30:00.000Z', '2027-10-31T01:30:00.000Z']);
  });
});
test('Calendar checkbox filters preserve account, status and URL state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await establishWorkspaceSession(page);
  await mockConnectedAccounts(page);
  const accounts = [
    ['00000000-0000-4000-8000-000000000201', 'Example Editorial', 'scheduled'],
    ['00000000-0000-4000-8000-000000000202', 'Studio Notes', 'published'],
  ];
  await page.route('**/api/workflow/jobs?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: accounts.map(([id, name, state], index) => ({
            id: `job-${String(index)}`,
            state,
            needsAttention: false,
            scheduledAt: '2026-10-20T10:00:00Z',
            contentPreview: 'Calendar test post',
            providerAccount: { id, displayName: name, handle: name, provider: 'x' },
          })),
          next: null,
        },
        error: null,
      }),
    }),
  );
  await page.route('**/api/workflow/calendar/exposed-pages?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: '{"data":{"items":[],"next":null},"error":null}',
    }),
  );
  await page.goto(await workspacePath(page, 'calendar?mode=Day&date=2026-10-20'));
  await expect(page.getByRole('button', { name: 'Show accounts: 3 accounts' })).toBeVisible();
  expect(errors).toEqual([]);
  await page.getByRole('button', { name: 'Show accounts: 3 accounts' }).click();
  await expect(
    page.getByRole('group', { name: 'Show accounts' }).getByRole('checkbox'),
  ).toHaveCount(3);
  await page.getByRole('checkbox', { name: /Studio Notes/ }).uncheck();
  await expect(page.locator('span.sr-only[aria-live="polite"]')).toHaveText(
    '1 post shown after filtering',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Show accounts: 2 of 3 accounts/ })).toBeFocused();
  await expect(page.getByRole('link', { name: /Example Editorial, Scheduled/ })).toHaveCount(1);
  await expect(page.getByRole('link', { name: /Studio Notes, Published/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show statuses: All statuses' }).click();
  await page.getByRole('checkbox', { name: 'Scheduled' }).uncheck();
  await expect(page.getByText('No posts match these filters')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: /Show accounts: 2 of 3 accounts/ })).toBeVisible();
  await expect(page.getByText('No posts match these filters')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Show statuses: All statuses' })).toBeVisible();
  for (const mode of ['Month', 'Week', 'Day', 'Timeline']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await expect(
      page
        .getByLabel(`${mode} calendar`)
        .getByRole('link', { name: /Example Editorial, Scheduled/ }),
    ).toHaveCount(1);
    await expect(
      page.getByLabel(`${mode} calendar`).getByRole('link', { name: /Studio Notes, Published/ }),
    ).toHaveCount(0);
  }
  if (page.viewportSize()?.width === 390) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  }
  await page.goto(await workspacePath(page, 'calendar?mode=Day&date=2026-10-20&statuses=unknown'));
  await expect(page.getByText('Some saved filters are no longer available.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Example Editorial, Scheduled/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(page.getByRole('link', { name: /Example Editorial, Scheduled/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Show accounts: 3 accounts' }).click();
  await page.getByRole('checkbox', { name: /Example Editorial/ }).uncheck();
  await page.getByRole('checkbox', { name: /Studio Notes/ }).uncheck();
  await page.getByRole('checkbox', { name: /Avery Studio/ }).uncheck();
  await expect(page.getByText('No accounts selected')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Calendar account filter includes paginated exposed Pages without clipping', async ({
  page,
}, testInfo) => {
  await establishWorkspaceSession(page);
  await page.route('**/api/provider-accounts*', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    const accounts = cursor
      ? [
          {
            id: '00000000-0000-4000-8000-000000000212',
            provider: 'meta',
            destinationProvider: 'facebook_page',
            displayName: 'Shared Page',
            originWorkspaceName: '21digital',
            status: 'active',
          },
        ]
      : [
          {
            id: '00000000-0000-4000-8000-000000000201',
            provider: 'x',
            destinationProvider: 'x',
            displayName: 'Example Editorial',
            handle: 'editorial-one',
            status: 'active',
          },
          {
            id: '00000000-0000-4000-8000-000000000202',
            provider: 'x',
            destinationProvider: 'x',
            displayName: 'Example Editorial',
            handle: 'editorial-two',
            status: 'active',
          },
        ];
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: { accounts, nextCursor: cursor ? null : 'page2' },
        error: null,
      }),
    });
  });
  await page.route('**/api/workflow/jobs?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: [
            {
              id: 'local-job',
              state: 'scheduled',
              needsAttention: false,
              scheduledAt: '2026-10-20T10:00:00Z',
              contentPreview: 'Local post',
              providerAccount: {
                id: '00000000-0000-4000-8000-000000000201',
                displayName: 'Example Editorial',
                handle: '',
                provider: 'x',
              },
            },
          ],
          next: null,
        },
        error: null,
      }),
    }),
  );
  await page.route('**/api/workflow/calendar/exposed-pages?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: [
            {
              id: 'shared-job',
              providerAccountId: '00000000-0000-4000-8000-000000000212',
              providerAccountName: 'Shared Page',
              originWorkspaceName: '21digital',
              state: 'scheduled',
              scheduledAt: '2026-10-20T11:00:00Z',
              contentPreview: 'Shared post',
              mediaCount: 0,
            },
          ],
          next: null,
        },
        error: null,
      }),
    }),
  );
  await page.goto(await workspacePath(page, 'calendar?mode=Day&date=2026-10-20'));
  await expect(page.getByRole('button', { name: 'Show accounts: 3 accounts' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: /Shared Page, Scheduled.*from 21digital/ }),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Show accounts: 3 accounts' }).click();
  await expect(
    page.getByRole('checkbox', { name: /Example Editorial.*@editorial-one.*Account 1 of 2/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: /Example Editorial.*@editorial-two.*Account 2 of 2/ }),
  ).toBeVisible();
  await expect(page.getByText('Facebook Pages', { exact: true })).toBeVisible();
  const menu = page.locator('.calendar-filter-menu');
  const box = await menu.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error('Calendar filter menu was not rendered');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  await page.screenshot({ path: testInfo.outputPath('calendar-account-filter.png') });
  await page.getByRole('checkbox', { name: /Shared Page.*From 21digital/ }).uncheck();
  await expect(page.getByRole('link', { name: /Shared Page, Scheduled/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Example Editorial, Scheduled/ })).toHaveCount(1);
});
