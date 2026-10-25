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

test('first-time email opens across devices and creates a single-use session', async ({
  page,
  browser,
}) => {
  await page.goto('/register');
  await page.getByLabel('Email').fill(`new-${crypto.randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');
  const developmentLink = page.getByRole('link', { name: 'Open development sign-in link' });
  const url = await developmentLink.getAttribute('href');
  if (!url) throw new Error('Development link was not rendered');
  const otherDevice = await browser.newContext({ userAgent: 'separate-email-client' });
  try {
    const otherPage = await otherDevice.newPage();
    await otherPage.goto(url);
    await expect(otherPage.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    await expect(otherPage).not.toHaveURL(/token=/);
    expect(await otherDevice.cookies()).toEqual([]);
    await otherPage.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(otherPage).toHaveURL(/\/app|\/w\//);
    await otherPage.reload();
    await expect(otherPage).not.toHaveURL(/\/login/);
    await page.goto(url);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page).toHaveURL(/\/login\?magicLink=invalid/);
  } finally {
    await otherDevice.close();
  }
});
