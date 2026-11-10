import { expect, test } from '@playwright/test';

const accountId = '00000000-0000-4000-8000-000000000281';
const keyId = '00000000-0000-4000-8000-000000000282';

test('Page guidance keeps shared facts separate from channel instructions', async ({
  page,
}, testInfo) => {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Guidance Owner',
      email: `guidance-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Guidance ${suffix}`,
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const saved = { profile: 'Christina lives in Sofia.', dmGuidance: '', commentGuidance: '' };
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
              displayName: 'Christina Page',
              status: 'active',
              availability: 'active',
              capabilityFreshness: 'fresh',
              capabilitySnapshot: { contentKinds: ['text'] },
              adapterDefaults: {},
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  await page.route(`**/api/provider-accounts/${accountId}/engagement`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          comments: { localEnabled: false, providerGrant: 'unknown' },
          dms: { localEnabled: false, providerGrant: 'unknown' },
        },
        error: null,
      }),
    }),
  );
  let failSave = true;
  await page.route(`**/api/facebook-pages/${accountId}/guidance`, (route) => {
    if (route.request().method() === 'PATCH') {
      if (failSave) {
        failSave = false;
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ data: null, error: 'Unavailable' }),
        });
      }
      Object.assign(saved, route.request().postDataJSON());
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: saved, error: null }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/accounts`);
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.getByRole('button', { name: 'Page guidance' }).click();
  const dialog = page.getByRole('dialog', { name: /Page guidance/ });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Shared Page profile' })).toHaveValue(
    saved.profile,
  );
  await dialog.getByRole('tab', { name: 'DM guidance' }).click();
  await expect(page.getByRole('textbox', { name: 'DM guidance' })).toHaveValue('');
  await dialog.getByRole('tab', { name: 'Public-comment guidance' }).click();
  await expect(page.getByRole('textbox', { name: 'Public-comment guidance' })).toHaveValue('');
  await page
    .getByRole('textbox', { name: 'Public-comment guidance' })
    .fill('Keep public replies playful.');
  await page.getByRole('button', { name: 'Save Page guidance' }).click();
  await expect(page.getByText('Page guidance was not saved. Retry.')).toBeVisible();
  await page.getByRole('button', { name: 'Save Page guidance' }).click();
  await expect(page.getByText('Page guidance saved.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('facebook-page-guidance-desktop.png') });
  await page.getByRole('button', { name: 'Close Page guidance' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.getByRole('button', { name: 'Page guidance' }).click();
  await dialog.getByRole('tab', { name: 'Public-comment guidance' }).click();
  await expect(page.getByRole('textbox', { name: 'Public-comment guidance' })).toHaveValue(
    'Keep public replies playful.',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error('Page guidance dialog has no visible bounds');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('facebook-page-guidance-mobile.png') });
  await dialog.getByRole('tab', { name: 'DM guidance' }).click();
  await page.getByRole('textbox', { name: 'DM guidance' }).fill('Answer privately.');
  await page.getByRole('button', { name: 'Close Page guidance' }).click();
  await expect(page.getByText('Discard unsaved Page guidance changes?')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByRole('textbox', { name: 'DM guidance' })).toHaveValue('Answer privately.');
});

test('Page owner manages separate local modules and explicit agent access', async ({
  page,
}, testInfo) => {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Page Owner',
      email: `page-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Page Desk ${suffix}`,
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = await page.request.get('/api/workspaces/current');
  const { data } = (await workspace.json()) as { data: { slug: string } };
  let commentsEnabled = false;
  let messagesGrant: 'missing' | 'verified' = 'missing';
  let messagesStartFailed = false;
  let capabilities: string[] = [];
  let failSave = true;
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
              displayName: 'Studio Page',
              status: 'active',
              availability: 'active',
              capabilityFreshness: 'fresh',
              capabilitySnapshot: { contentKinds: ['text'] },
              adapterDefaults: {},
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  await page.route(`**/api/provider-accounts/${accountId}/engagement`, (route) => {
    if (route.request().method() === 'PATCH')
      commentsEnabled = (route.request().postDataJSON() as { enabled: boolean }).enabled;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          comments: { localEnabled: commentsEnabled, providerGrant: 'unknown' },
          dms: { localEnabled: messagesGrant === 'verified', providerGrant: messagesGrant },
        },
        error: null,
      }),
    });
  });
  await page.route('**/api/oauth/meta/facebook-page-messages', (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ accountId });
    if (!messagesStartFailed) {
      messagesStartFailed = true;
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: 'Selected Page needs reconnection' }),
      });
    }
    messagesGrant = 'verified';
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          authorizationUrl: `/w/${data.slug}/accounts?oauth=meta-facebook_page_messages-connected`,
        },
        error: null,
      }),
    });
  });
  await page.route(`**/api/provider-accounts/${accountId}/engagement/principals`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            kind: 'api-key',
            id: keyId,
            label: 'Review agent',
            capabilities,
            eligibleCapabilities: ['comments:read', 'comments:propose'],
          },
        ],
        error: null,
      }),
    }),
  );
  await page.route(`**/api/provider-accounts/${accountId}/engagement/grants`, (route) => {
    if (failSave) {
      failSave = false;
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: 'Access could not be saved' }),
      });
    }
    capabilities = (route.request().postDataJSON() as { capabilities: string[] }).capabilities;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { saved: true }, error: null }),
    });
  });
  await page.goto(`/w/${data.slug}/accounts`);
  const control = page.locator('.x-long-post-setting').filter({ hasText: 'Optional Page modules' });
  await expect(control.getByRole('switch', { name: 'Comments' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(control).toContainText('Provider grant: unknown');
  await expect(control).toContainText('Provider grant: missing');
  await control.getByRole('button', { name: 'Enable Messages' }).click();
  await expect(control.getByRole('alert')).toContainText('Selected Page needs reconnection');
  await page.screenshot({ path: testInfo.outputPath('messages-start-error.png'), fullPage: true });
  await control.getByRole('button', { name: 'Enable Messages' }).click();
  await expect(page.locator('.account-module-success')).toContainText(
    'Messages permission was verified',
  );
  await expect(control).toContainText('Provider grant: verified');
  await expect(control.getByRole('button', { name: 'Reconnect Messages' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('messages-verified.png'), fullPage: true });
  await control.getByRole('switch', { name: 'Comments' }).click();
  await expect(control.getByRole('switch', { name: 'Comments' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await control.getByRole('button', { name: 'Manage agent access' }).click();
  await expect(control).toContainText('Review agent');
  await control.getByRole('button', { name: 'Edit Page access' }).click();
  await control.getByRole('button', { name: 'Read comments' }).click();
  await control.getByRole('button', { name: 'Suggest comment replies' }).click();
  await control.getByRole('button', { name: 'Save access' }).click();
  await expect(control.getByRole('alert')).toContainText('Access could not be saved');
  await control.getByRole('button', { name: 'Save access' }).click();
  await expect(control.getByRole('button', { name: 'Edit Page access' })).toBeVisible();
  expect(capabilities).toEqual(['comments:read', 'comments:propose']);
  await page.screenshot({
    path: testInfo.outputPath('page-engagement-agent-access.png'),
    fullPage: true,
  });
  await page.reload();
  await expect(control.getByRole('switch', { name: 'Comments' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await control.getByRole('button', { name: 'Manage agent access' }).click();
  await control.getByRole('button', { name: 'Edit Page access' }).click();
  await expect(control.getByRole('button', { name: 'Read comments' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await control.getByRole('button', { name: 'Read comments' }).click();
  await control.getByRole('button', { name: 'Suggest comment replies' }).click();
  await control.getByRole('button', { name: 'Save access' }).click();
  expect(capabilities).toEqual([]);
  await control.getByRole('switch', { name: 'Comments' }).click();
  await expect(control.getByRole('switch', { name: 'Comments' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    testInfo.project.name === 'mobile' ? 390 : 1440,
  );
  await page.route('**/api/settings/api-keys', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: [],
          eligibleCapabilities: ['destinations:read', 'comments:read', 'dms:send'],
          defaultCapabilities: ['destinations:read'],
        },
        error: null,
      }),
    }),
  );
  await page.goto(`/w/${data.slug}/settings/automation`);
  const createKey = page.locator('.settings-card').filter({ hasText: 'Create API key' });
  await expect(createKey.getByRole('button', { name: 'destinations:read' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(createKey.getByRole('button', { name: 'comments:read' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(createKey.getByRole('button', { name: 'dms:send' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
