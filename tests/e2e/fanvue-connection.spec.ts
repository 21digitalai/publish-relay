import { expect, test } from '@playwright/test';

test('Fanvue publishing consent appears only as its own adapter and persists a creator connection', async ({
  page,
}) => {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registration = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Fanvue Fixture',
      email: `fanvue-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Fanvue ${suffix}`,
    },
  });
  expect(registration.ok()).toBe(true);
  const current = await page.request.get('/api/workspaces/current');
  const { data } = (await current.json()) as { data: { slug: string } };
  const accountsPath = `/w/${data.slug}/accounts`;
  let denyFirstChatRead = true;
  let rejectFirstChatReadScope = true;
  let rejectFirstChatSendScope = true;
  await page.route('https://auth.fanvue.com/**', (route) => {
    const auth = new URL(route.request().url());
    const scopes = auth.searchParams.get('scope') ?? '';
    expect(scopes).not.toMatch(/comment/);
    if (scopes.includes('write:chat')) expect(scopes).toContain('read:chat');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    const state = auth.searchParams.get('state');
    if (!state) throw new Error('Fanvue authorization state was not present');
    const denied = scopes.includes('read:chat') && denyFirstChatRead;
    if (denied) denyFirstChatRead = false;
    const readMissingScope =
      scopes.includes('read:chat') &&
      !scopes.includes('write:chat') &&
      !denied &&
      rejectFirstChatReadScope;
    if (readMissingScope) rejectFirstChatReadScope = false;
    const sendMissingScope = scopes.includes('write:chat') && rejectFirstChatSendScope;
    if (sendMissingScope) rejectFirstChatSendScope = false;
    return route.fulfill({
      status: 302,
      headers: {
        Location: `http://127.0.0.1:43199/api/oauth/fanvue/callback?state=${state}&${denied ? 'error=access_denied' : `code=${sendMissingScope ? 'fixture-chat-send-no-scope' : readMissingScope ? 'fixture-chat-read-no-scope' : scopes.includes('write:chat') ? 'fixture-chat-send' : scopes.includes('read:chat') ? 'fixture-chat-read' : 'fixture'}`}`,
      },
    });
  });
  await page.goto(accountsPath);
  await page.getByRole('button', { name: '＋ Add Posting Adapter' }).click();
  const fanvue = page.getByRole('button', { name: /Fanvue Connect publishing only/ });
  await expect(fanvue).toBeVisible();
  await fanvue.click();
  await page.waitForURL('**/app?oauth=fanvue-connected');
  await page.goto(accountsPath);
  await expect(page.getByText('Fixture Creator').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow message reading' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow message reading' }).click();
  await page.waitForURL('**/app?oauth=fanvue-chat-read-denied');
  await expect(
    page.getByText('Fanvue message reading was not enabled. Authorization was cancelled.'),
  ).toBeVisible();
  await page.goto(accountsPath);
  await expect(page.getByRole('button', { name: 'Allow message reading' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow message reading' }).click();
  await page.waitForURL('**/app?oauth=fanvue-chat-read-scope');
  await expect(page.getByText(/message reading.*not enabled/i)).toBeVisible();
  await page.goto(accountsPath);
  await page.getByRole('button', { name: 'Allow message reading' }).click();
  await page.waitForURL('**/app?oauth=fanvue-chat-read-connected');
  await expect(
    page.getByText('Fanvue message reading is connected for the selected account.'),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText('Fixture Creator').first()).toBeVisible();
  await expect(page.getByText('Message reading enabled')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow message reading' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Allow message sending' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow message sending' }).click();
  await page.waitForURL('**/app?oauth=fanvue-chat-send-scope');
  await expect(page.getByText(/message sending.*not enabled/i)).toBeVisible();
  await page.goto(accountsPath);
  await expect(page.getByText('Message reading enabled')).toBeVisible();
  await page.getByRole('button', { name: 'Allow message sending' }).click();
  await page.waitForURL('**/app?oauth=fanvue-chat-send-connected');
  await expect(
    page.getByText('Fanvue message sending is connected for the selected account.'),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText('Message sending enabled')).toBeVisible();
  const accountsResponse = await page.request.get('/api/provider-accounts');
  const accounts = (await accountsResponse.json()) as {
    data: { accounts: Record<string, unknown>[] };
  };
  const fanvueAccount = accounts.data.accounts.find((account) => account.provider === 'fanvue');
  expect(fanvueAccount?.fanvueModules).toEqual({ chatRead: true, chatSend: true });
  expect(fanvueAccount).not.toHaveProperty('scopes');
});
