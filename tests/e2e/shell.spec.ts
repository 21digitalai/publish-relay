import { expect, test } from '@playwright/test';

test('renders the Publish Relay shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Publish Relay' })).toBeVisible();
});
