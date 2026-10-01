import { expect, test } from '@playwright/test';

const TIKTOK_ONE = '00000000-0000-4000-8000-000000000301';
const TIKTOK_TWO = '00000000-0000-4000-8000-000000000302';
const X_ACCOUNT = '00000000-0000-4000-8000-000000000303';

test('TikTok uses one explicit account, fresh options, and an unavailable final action', async ({
  page,
}, testInfo) => {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registration = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Relay Owner',
      email: `tiktok-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `TikTok ${suffix}`,
    },
  });
  expect(registration.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: TIKTOK_ONE,
              provider: 'tiktok',
              displayName: 'TikTok One',
              status: 'active',
              availability: 'active',
            },
            {
              id: TIKTOK_TWO,
              provider: 'tiktok',
              displayName: 'TikTok Two',
              status: 'active',
              availability: 'active',
            },
            {
              id: X_ACCOUNT,
              provider: 'x',
              displayName: 'X Account',
              status: 'active',
              availability: 'active',
            },
          ],
        },
        error: null,
      }),
    }),
  );
  let changedOptions = false;
  await page.route('**/api/provider-accounts/*/tiktok-capabilities', (route) => {
    const accountId = route.request().url().includes(TIKTOK_ONE) ? TIKTOK_ONE : TIKTOK_TWO;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: '00000000-0000-4000-8000-000000000399',
          accountId,
          nickname: accountId === TIKTOK_ONE ? 'Fresh Creator One' : 'Fresh Creator Two',
          privacyOptions: changedOptions ? ['SELF_ONLY'] : ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
          commentDisabled: false,
          duetDisabled: true,
          stitchDisabled: true,
          maxVideoDurationSeconds: 60,
          fetchedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        },
        error: null,
      }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/queue`);
  await page.getByRole('button', { name: 'Create post' }).last().click();
  const first = page.getByRole('checkbox', { name: /TikTok One/ });
  const second = page.getByRole('checkbox', { name: /TikTok Two/ });
  const x = page.getByRole('checkbox', { name: /X Account/ });
  await expect(first).not.toBeChecked();
  await expect(second).not.toBeChecked();
  await first.check();
  await expect(x).not.toBeChecked();
  await expect(page.getByText('Posting as')).toContainText('Fresh Creator One');
  await expect(page.getByRole('button', { name: 'Visibility' })).toContainText('Choose visibility');
  await expect(page.getByLabel('Duet')).toBeDisabled();
  await expect(page.getByLabel('Stitch')).toBeDisabled();
  await expect(page.getByRole('radio', { name: 'Yes' })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'No' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'TikTok scheduling unavailable' })).toBeDisabled();
  await page.getByRole('button', { name: 'Visibility' }).click();
  await page.getByRole('option', { name: 'Everyone' }).click();
  await page.locator('#composer-media-upload').setInputFiles({
    name: 'draft.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('fixture video bytes'),
  });
  await expect(page.locator('video[aria-label="Preview draft.mp4"]')).toBeVisible();
  await page.getByRole('textbox', { name: 'Caption' }).fill('A deliberate caption');
  await page.getByRole('radio', { name: 'Yes' }).check();
  await expect(page.getByRole('region', { name: 'Review TikTok publication' })).toContainText(
    'A deliberate caption',
  );
  await page.screenshot({
    path: testInfo.outputPath('tiktok-composer-populated.png'),
    fullPage: true,
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page
      .locator('.composer-sheet')
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe('none');
  changedOptions = true;
  await page.getByRole('button', { name: 'Refresh TikTok options' }).click();
  await expect(page.getByText('This visibility is no longer available')).toBeVisible();
  await second.check();
  await expect(first).not.toBeChecked();
  await expect(page.getByText('Posting as')).toContainText('Fresh Creator Two');
  await expect(page.getByText('This visibility is no longer available')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('tiktok-composer-switched.png'),
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test('TikTok creator failure and expiry remain visible and recoverable without posting', async ({
  page,
}) => {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registration = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Relay Owner',
      email: `tiktok-recovery-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `TikTok recovery ${suffix}`,
    },
  });
  expect(registration.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: TIKTOK_ONE,
              provider: 'tiktok',
              displayName: 'TikTok One',
              status: 'active',
              availability: 'active',
            },
          ],
        },
        error: null,
      }),
    }),
  );
  let failed = true;
  await page.route('**/api/provider-accounts/*/tiktok-capabilities', (route) =>
    route.fulfill(
      failed
        ? {
            status: 502,
            contentType: 'application/json',
            body: '{"data":null,"error":"TikTok options could not be refreshed"}',
          }
        : {
            contentType: 'application/json',
            body: JSON.stringify({
              data: {
                id: '00000000-0000-4000-8000-000000000399',
                accountId: TIKTOK_ONE,
                nickname: 'Fresh Creator',
                privacyOptions: ['SELF_ONLY'],
                commentDisabled: true,
                duetDisabled: true,
                stitchDisabled: true,
                maxVideoDurationSeconds: 60,
                fetchedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
                expiresAt: new Date(Date.now() - 60_000).toISOString(),
              },
              error: null,
            }),
          },
    ),
  );
  await page.goto(`/w/${workspace.data.slug}/queue`);
  await page.getByRole('button', { name: 'Create post' }).last().click();
  const account = page.getByRole('checkbox', { name: /TikTok One/ });
  await expect(account).not.toBeChecked();
  await account.focus();
  await page.keyboard.press('Space');
  await expect(account).toBeChecked();
  await expect(page.getByRole('alert')).toContainText('TikTok options could not be refreshed');
  await expect(page.getByRole('button', { name: 'TikTok scheduling unavailable' })).toBeDisabled();
  failed = false;
  await page.getByRole('button', { name: 'Refresh TikTok options' }).click();
  await expect(page.getByText('TikTok options expired')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Visibility' })).toContainText('Choose visibility');
  await expect(page.getByRole('button', { name: 'TikTok scheduling unavailable' })).toBeDisabled();
});
