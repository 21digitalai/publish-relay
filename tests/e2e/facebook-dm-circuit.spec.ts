import { expect, test } from '@playwright/test';

const accountId = '00000000-0000-4000-8000-000000000071';

test('Page DM pause survives reload and owner can explicitly resume', async ({
  page,
}, testInfo) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Circuit Owner',
      email: `circuit-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Circuit Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  let halted = true;
  let clearanceCount = 0;
  let rejectFirstClear = true;
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      json: {
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
      },
    }),
  );
  await page.route(`**/api/provider-accounts/${accountId}/engagement`, (route) =>
    route.fulfill({
      json: {
        data: {
          comments: { localEnabled: false, providerGrant: 'missing' },
          dms: { localEnabled: true, providerGrant: 'verified' },
        },
        error: null,
      },
    }),
  );
  await page.route(`**/api/provider-accounts/${accountId}/facebook-dm-circuit`, (route) =>
    route.fulfill({
      json: {
        data: {
          consecutiveFailures: halted ? 3 : 0,
          haltedAt: halted ? '2026-11-11T12:00:00Z' : null,
        },
        error: null,
      },
    }),
  );
  await page.route(`**/api/provider-accounts/${accountId}/facebook-dm-circuit/clear`, (route) => {
    clearanceCount += 1;
    if (rejectFirstClear) {
      rejectFirstClear = false;
      return route.fulfill({
        status: 503,
        json: { data: null, error: 'Clear temporarily unavailable' },
      });
    }
    halted = false;
    return route.fulfill({
      json: { data: { consecutiveFailures: 0, haltedAt: null }, error: null },
    });
  });

  await page.goto(`/w/${workspace.data.slug}/accounts`);
  const account = page.locator('.account-row').first();
  await account.getByRole('button', { name: 'Manage' }).click();
  const paused = account.locator('.facebook-dm-circuit-status');
  await expect(paused).toContainText('Page DM sending paused');
  await expect(paused).toContainText('Pending messages remain queued');
  await page.reload();
  await account.getByRole('button', { name: 'Manage' }).click();
  await expect(paused).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('page-dm-paused.png') });
  await paused.getByRole('button', { name: 'Review resume' }).click();
  await expect(paused).toContainText('Resuming permits pending Page DMs');
  await paused.getByRole('button', { name: 'Cancel' }).click();
  expect(clearanceCount).toBe(0);
  await paused.getByRole('button', { name: 'Review resume' }).click();
  await paused.getByRole('button', { name: 'Confirm resume' }).click();
  await expect(account.getByRole('alert')).toContainText('Clear temporarily unavailable');
  await expect(paused).toBeVisible();
  await paused.getByRole('button', { name: 'Confirm resume' }).click();
  await expect(paused).toHaveCount(0);
  expect(clearanceCount).toBe(2);
  await page.reload();
  await account.getByRole('button', { name: 'Manage' }).click();
  await expect(paused).toHaveCount(0);
});
