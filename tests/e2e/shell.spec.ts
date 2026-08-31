import { expect, test } from '@playwright/test';

test('renders the login surface and reports a safe demo error', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in to your cockpit' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Demo mode is active');
});

test('filters accounts and opens a named disconnect confirmation', async ({ page }) => {
  await page.goto('/w/atlas/accounts');
  await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible();
  await expect(page.getByText('Studio Notes')).toBeVisible();
  await page.getByPlaceholder('Search name or handle').fill('Mira');
  await expect(page.getByText('Mira Studio')).toBeVisible();
  await expect(page.getByText('Daily Viber')).toBeHidden();
  await page.getByPlaceholder('Search name or handle').fill('');
  await page.getByRole('button', { name: 'More actions for Studio Notes' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Disconnect Studio Notes?');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
});

test('uses the mobile navigation drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/w/atlas/accounts');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByLabel('Primary navigation')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create post' })).toBeVisible();
});
