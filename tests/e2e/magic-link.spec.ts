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
    const verificationContentTypes: string[] = [];
    await otherPage.route('**/api/auth/magic-link/verify', async (route) => {
      if (route.request().method() === 'POST') {
        const contentType = route.request().headers()['content-type'] ?? '';
        verificationContentTypes.push(contentType);
        if (contentType.includes('application/x-www-form-urlencoded')) {
          await route.fulfill({ status: 302, headers: { location: '/login?magicLink=invalid' } });
          return;
        }
      }
      await route.continue();
    });
    await otherPage.goto(url);
    await expect(otherPage.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    await expect(otherPage).not.toHaveURL(/token=/);
    expect(await otherDevice.cookies()).toEqual([]);
    await otherPage.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(otherPage).toHaveURL(/\/app|\/w\//);
    expect(verificationContentTypes).toEqual(['application/json']);
    await otherPage.reload();
    await expect(otherPage).not.toHaveURL(/\/login/);
    await page.goto(url);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page).toHaveURL(/\/login\?magicLink=invalid/);
    await expect(page.getByRole('alert')).toContainText(
      'This sign-in link is invalid, expired, or already used.',
    );
    await expect(page.getByRole('alert')).toContainText('request a fresh link');
  } finally {
    await otherDevice.close();
  }
});

test('native Continue signs in when JavaScript is disabled', async ({ page, browser }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`no-js-${crypto.randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  const url = await page
    .getByRole('link', { name: 'Open development sign-in link' })
    .getAttribute('href');
  if (!url) throw new Error('Development link was not rendered');
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const noJsPage = await context.newPage();
    await noJsPage.goto(url);
    await expect(noJsPage.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    expect(await context.cookies()).toEqual([]);
    await noJsPage.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(noJsPage).toHaveURL(/\/app|\/w\//);
    expect(await context.cookies()).not.toEqual([]);
  } finally {
    await context.close();
  }
});

test('Continue retries after a network failure without consuming the link', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`retry-${crypto.randomUUID()}@example.test`);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  const url = await page
    .getByRole('link', { name: 'Open development sign-in link' })
    .getAttribute('href');
  if (!url) throw new Error('Development link was not rendered');
  let interrupted = false;
  await page.route('**/api/auth/magic-link/verify', async (route) => {
    if (route.request().method() === 'POST' && !interrupted) {
      interrupted = true;
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.goto(url);
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true });
  await continueButton.click();
  await expect(page.getByRole('alert')).toContainText('Please try again');
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(page).toHaveURL(/\/app|\/w\//);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`invalid sign-in link shows recovery at ${String(viewport.width)}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/register?magicLink=invalid');
    await expect(page.getByRole('alert')).toContainText(
      'This sign-in link is invalid, expired, or already used.',
    );
    await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
  });
}
