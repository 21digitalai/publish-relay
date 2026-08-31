import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function establishWorkspaceSession(page: Page) {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const response = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Relay Owner',
      email: `owner-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Atlas ${suffix}`,
    },
  });
  expect(response.ok()).toBe(true);
}

test('renders the login surface and reports an inline authentication error', async ({ page }) => {
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: 'Invalid email or password' }),
    }),
  );
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in to your cockpit' })).toBeVisible();
  await page.getByLabel('Email').fill('owner@example.test');
  await page.getByLabel('Password').fill('incorrect-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');
});

test('renders the honest recovery unavailable state', async ({ page }) => {
  await page.goto('/forgot-password');
  await expect(page.getByRole('heading', { name: 'Recovery is not available yet' })).toBeVisible();
  await expect(page.getByText('We will not claim that an email was sent')).toBeVisible();
});

test('registers, persists the first workspace update, and reloads the protected onboarding route', async ({
  page,
}, testInfo) => {
  const suffix = Math.random().toString(36).slice(2);
  const workspaceSlug = `atlas-publishing-${suffix}`;
  await page.goto('/register');
  await page.getByLabel('Name', { exact: true }).fill('Relay Owner');
  await page.getByLabel('Workspace name').fill(`Atlas Studio ${suffix}`);
  await page.getByLabel('Email').fill(`owner-${suffix}@example.test`);
  await page.getByLabel('Password').fill('long-password-123!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding\/workspace$/);
  await page.getByLabel('Workspace name').fill('Atlas Publishing');
  await page.getByLabel('Workspace URL').fill(workspaceSlug);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Connect your first account' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Name your workspace' })).toBeVisible();
  await expect(page.getByLabel('Workspace name')).toHaveValue('Atlas Publishing');
  await expect(page.getByLabel('Workspace URL')).toHaveValue(workspaceSlug);
  await page.screenshot({ path: testInfo.outputPath('persisted-onboarding.png'), fullPage: true });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page).toHaveURL(`/w/${workspaceSlug}/accounts`);
});

test('filters accounts and opens a named disconnect confirmation', async ({ page }) => {
  await establishWorkspaceSession(page);
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
  await establishWorkspaceSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/w/atlas/accounts');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByLabel('Primary navigation')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create post' })).toBeVisible();
});
