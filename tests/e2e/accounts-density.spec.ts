import { expect, test } from '@playwright/test';

test('twenty accounts remain scannable and reveal existing controls on demand', async ({
  page,
}) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Density Owner',
      email: `density-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Density Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: Array.from({ length: 20 }, (_, index) => ({
            id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            provider: 'meta',
            destinationProvider: 'facebook_page',
            displayName: `Page ${String(index + 1).padStart(2, '0')}`,
            status: index === 0 ? 'reconnect_required' : 'active',
            availability: 'active',
            capabilityFreshness: 'fresh',
            capabilitySnapshot: { contentKinds: ['text'] },
            adapterDefaults: {},
          })),
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  await page.goto(`/w/${workspace.data.slug}/accounts`);
  const rows = page.locator('.account-row');
  await expect(rows).toHaveCount(20);
  await expect(page.getByRole('button', { name: 'Page guidance' })).toHaveCount(0);
  const first = rows.first();
  const firstBox = await first.boundingBox();
  expect(firstBox?.height).toBeLessThanOrEqual(test.info().project.name === 'mobile' ? 110 : 80);
  await expect(first).toContainText('Page 01');
  await expect(first.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  await first.getByRole('button', { name: 'Manage' }).click();
  await expect(first.getByRole('button', { name: 'Page guidance' })).toBeVisible();
  await first.getByRole('button', { name: 'Hide details' }).click();
  await page.getByPlaceholder('Search name or handle').fill('Page 20');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Page 20');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
});
