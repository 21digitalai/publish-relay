import { expect, test } from '@playwright/test';

const accountId = '00000000-0000-4000-8000-000000000281';
const label = 'One autonomous DM reply group per person per Sofia day';

test('Page DM daily limit persists, reverses, and reports a failed save', async ({
  page,
}, testInfo) => {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Relay Owner',
      email: `owner-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Atlas ${suffix}`,
    },
  });
  expect(registered.ok()).toBe(true);
  const current = await page.request.get('/api/workspaces/current');
  const workspace = (await current.json()) as { data: { slug: string } };
  let enabled = false;
  let maximum: 1 | 2 = 1;
  let pacing: 'standard' | 'recovery' = 'standard';
  let failNextSave = false;
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
              displayName: 'Christina Test Page',
              status: 'active',
              availability: 'active',
              updatedAt: '2026-11-11T00:00:00Z',
              adapterDefaults: {},
            },
          ],
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
          comments: { localEnabled: false, providerGrant: 'missing' },
          dms: { localEnabled: true, providerGrant: 'verified' },
          dmDailyGroupLimitEnabled: enabled,
          dmDailyGroupMaximum: maximum,
          dmRootPacing: pacing,
        },
        error: null,
      }),
    }),
  );
  await page.route(`**/api/provider-accounts/${accountId}/facebook-dm-circuit`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { consecutiveFailures: 0, haltedAt: null }, error: null }),
    }),
  );
  await page.route(
    `**/api/provider-accounts/${accountId}/facebook-dm-daily-group-limit`,
    async (route) => {
      if (failNextSave) {
        failNextSave = false;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ data: null, error: 'Daily limit save failed' }),
        });
      }
      const request = route.request().postDataJSON() as { enabled: boolean; maximum: 1 | 2 };
      enabled = request.enabled;
      maximum = request.maximum;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            comments: { localEnabled: false, providerGrant: 'missing' },
            dms: { localEnabled: true, providerGrant: 'verified' },
            dmDailyGroupLimitEnabled: enabled,
            dmDailyGroupMaximum: maximum,
            dmRootPacing: pacing,
          },
          error: null,
        }),
      });
    },
  );
  await page.route(
    `**/api/provider-accounts/${accountId}/facebook-dm-root-pacing`,
    async (route) => {
      const request = route.request().postDataJSON() as { mode: 'standard' | 'recovery' };
      pacing = request.mode;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            comments: { localEnabled: false, providerGrant: 'missing' },
            dms: { localEnabled: true, providerGrant: 'verified' },
            dmDailyGroupLimitEnabled: enabled,
            dmDailyGroupMaximum: maximum,
            dmRootPacing: pacing,
          },
          error: null,
        }),
      });
    },
  );
  await page.goto(`/w/${workspace.data.slug}/accounts`);
  const row = page.locator('.account-row').filter({ hasText: 'Christina Test Page' });
  await row.getByRole('button', { name: 'Manage', exact: true }).click();
  const toggle = row.getByRole('switch', { name: label });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  const pacingToggle = row.getByRole('switch', {
    name: 'Recovery pacing: 5–7 minutes between people',
  });
  await expect(pacingToggle).toHaveAttribute('aria-checked', 'false');
  await pacingToggle.click();
  await expect(pacingToggle).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('daily-limit-off.png'), fullPage: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const fallback = row.getByRole('switch', {
    name: 'Allow one second group after a fresh reply',
  });
  await expect(fallback).toHaveAttribute('aria-checked', 'false');
  await fallback.click();
  await expect(fallback).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await row.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(fallback).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await row.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({
    path: testInfo.outputPath('daily-limit-on-reloaded.png'),
    fullPage: true,
  });
  failNextSave = true;
  await toggle.click();
  await expect(row.getByRole('alert')).toContainText('Daily limit save failed');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.screenshot({
    path: testInfo.outputPath('daily-limit-off-reversed.png'),
    fullPage: true,
  });
});

test('non-owner cannot see the Page daily limit control', async ({ page }) => {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Relay Member',
      email: `member-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Atlas ${suffix}`,
    },
  });
  expect(registered.ok()).toBe(true);
  const current = await page.request.get('/api/workspaces/current');
  const body = (await current.json()) as { data: { workspace: { role: string }; slug: string } };
  await page.route('**/api/workspaces/current', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...body,
        data: { ...body.data, workspace: { ...body.data.workspace, role: 'member' } },
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
              displayName: 'Christina Test Page',
              status: 'active',
              availability: 'active',
              updatedAt: '2026-11-11T00:00:00Z',
              adapterDefaults: {},
            },
          ],
        },
        error: null,
      }),
    }),
  );
  await page.goto(`/w/${body.data.slug}/accounts`);
  const row = page.locator('.account-row').filter({ hasText: 'Christina Test Page' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(row.getByRole('switch', { name: label })).toHaveCount(0);
});
