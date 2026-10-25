import { expect, test } from '@playwright/test';

const accountId = '00000000-0000-4000-8000-000000000281';
const keyId = '00000000-0000-4000-8000-000000000282';

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
          dms: { localEnabled: false, providerGrant: 'missing' },
        },
        error: null,
      }),
    });
  });
  await page.route(`**/api/provider-accounts/${accountId}/engagement/principals`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{ kind: 'api-key', id: keyId, label: 'Review agent', capabilities }],
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
});
