import { expect, test } from '@playwright/test';

for (const route of ['/login', '/register', '/forgot-password']) {
  test(`${route} is the same email-only access surface`, async ({ page }) => {
    await page.goto(route);
    await expect(page.getByRole('heading', { name: 'Continue to Publish Relay' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveCount(0);
    await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Workspace name')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible();
  });
}

test('first-time email creates a session through a single-use link', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Email').fill(`new-${crypto.randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');
  const developmentLink = page.getByRole('link', { name: 'Open development sign-in link' });
  const url = await developmentLink.getAttribute('href');
  if (!url) throw new Error('Development link was not rendered');
  await developmentLink.click();
  await expect(page).toHaveURL(/\/app|\/w\//);
  await page.reload();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(url);
  await expect(page).toHaveURL(/\/login\?magicLink=invalid/);
});
