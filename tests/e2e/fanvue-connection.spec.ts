import { expect, test } from '@playwright/test';

test('Fanvue publishing consent appears only as its own adapter and persists a creator connection', async ({
  page,
}, testInfo) => {
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
  let denyFirstPayment = true;
  let rejectFirstPaymentScope = true;
  await page.route('https://auth.fanvue.com/**', (route) => {
    const auth = new URL(route.request().url());
    const scopes = auth.searchParams.get('scope') ?? '';
    expect(scopes).not.toMatch(/comment/);
    if (scopes.includes('write:chat')) expect(scopes).toContain('read:chat');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    const state = auth.searchParams.get('state');
    if (!state) throw new Error('Fanvue authorization state was not present');
    const payment = scopes.includes('read:creator');
    const denied = payment ? denyFirstPayment : scopes.includes('read:chat') && denyFirstChatRead;
    if (denied && payment) denyFirstPayment = false;
    else if (denied) denyFirstChatRead = false;
    const readMissingScope =
      !payment &&
      scopes.includes('read:chat') &&
      !scopes.includes('write:chat') &&
      !denied &&
      rejectFirstChatReadScope;
    if (readMissingScope) rejectFirstChatReadScope = false;
    const sendMissingScope = !payment && scopes.includes('write:chat') && rejectFirstChatSendScope;
    if (sendMissingScope) rejectFirstChatSendScope = false;
    const paymentMissingScope = payment && !denied && rejectFirstPaymentScope;
    if (paymentMissingScope) rejectFirstPaymentScope = false;
    return route.fulfill({
      status: 302,
      headers: {
        Location: `http://127.0.0.1:43199/api/oauth/fanvue/callback?state=${state}&${denied ? 'error=access_denied' : `code=${paymentMissingScope ? 'fixture-payment-no-scope' : payment ? 'fixture-payment' : sendMissingScope ? 'fixture-chat-send-no-scope' : readMissingScope ? 'fixture-chat-read-no-scope' : scopes.includes('write:chat') ? 'fixture-chat-send' : scopes.includes('read:chat') ? 'fixture-chat-read' : 'fixture'}`}`,
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
  await expect(page.getByRole('button', { name: 'Allow payment signals' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow payment signals' }).click();
  await page.waitForURL('**/app?oauth=fanvue-payment-denied');
  await expect(page.getByText(/payment signals were not enabled/i)).toBeVisible();
  await page.goto(accountsPath);
  await page.getByRole('button', { name: 'Allow payment signals' }).click();
  await page.waitForURL('**/app?oauth=fanvue-payment-scope');
  await expect(page.getByText(/required permission was not granted/i)).toBeVisible();
  await page.goto(accountsPath);
  await expect(page.getByText('Message sending enabled')).toBeVisible();
  await page.getByRole('button', { name: 'Allow payment signals' }).click();
  await page.waitForURL('**/app?oauth=fanvue-payment-connected');
  await page.reload();
  await expect(page.getByText('Payment signals enabled')).toBeVisible();
  await expect(page.getByText('Message sending enabled')).toBeVisible();
  const accountsResponse = await page.request.get('/api/provider-accounts');
  const accounts = (await accountsResponse.json()) as {
    data: { accounts: Record<string, unknown>[] };
  };
  const fanvueAccount = accounts.data.accounts.find((account) => account.provider === 'fanvue');
  expect(fanvueAccount?.fanvueModules).toEqual({
    chatRead: true,
    chatSend: true,
    paymentRead: true,
  });
  expect(fanvueAccount).not.toHaveProperty('scopes');

  await page.goto(`/w/${data.slug}/queue`);
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await page.getByRole('radio', { name: /Fanvue.*Fixture Creator/ }).click();
  await expect(page.getByRole('button', { name: 'Who can see this post' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
  await page.getByRole('button', { name: 'Who can see this post' }).click();
  await page.getByRole('option', { name: 'Subscribers', exact: true }).click();
  await page.getByLabel('Post body').fill('Fixture Fanvue post');
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('fanvue-free-composer.png') });
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();

  await page.goto(`/w/${data.slug}/queue`);
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await page.getByRole('radio', { name: /Fanvue.*Fixture Creator/ }).click();
  await page.getByRole('button', { name: 'Who can see this post' }).click();
  await page.getByRole('option', { name: 'Followers and subscribers' }).click();
  await page.getByLabel('Post body').fill('Immediate Fanvue fixture');
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish now' })).toBeEnabled();
  await page.getByRole('button', { name: 'Publish now' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();

  const requests: unknown[] = [];
  const mediaId = '00000000-0000-4000-8000-000000000027';
  await page.route('**/api/workflow/media', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: mediaId }, error: null }),
    }),
  );
  await page.route('**/api/workflow/posts', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: '{"data":{"jobs":[{}]},"error":null}',
    });
  });
  await page.goto(`/w/${data.slug}/queue`);
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await page.getByRole('radio', { name: /Fanvue.*Fixture Creator/ }).click();
  await page.getByRole('button', { name: 'Who can see this post' }).click();
  await page.getByRole('option', { name: 'Followers and subscribers' }).click();
  await page.getByLabel('Post body').fill('Paid fixture');
  await page.locator('.fanvue-price-input').fill('2.99');
  await expect(page.getByText('Paid posts start at $3.00;')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('fanvue-price-validation.png') });
  await page.locator('.fanvue-price-input').fill('3.05');
  await expect(page.getByText('Add media to a paid post.')).toBeVisible();
  await page.locator('#composer-media-upload').setInputFiles({
    name: 'preview.png',
    mimeType: 'image/png',
    buffer: Buffer.from('fixture'),
  });
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('fanvue-paid-composer.png') });
  await page.getByRole('button', { name: 'Schedule 1 post' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
  expect(requests).toEqual([
    expect.objectContaining({
      destination: expect.objectContaining({ provider: 'fanvue' }),
      content: {
        schemaVersion: 1,
        kind: 'post',
        audience: 'followers-and-subscribers',
        text: 'Paid fixture',
        mediaIds: [mediaId],
        price: 305,
      },
    }),
  ]);

  await page.route('**/api/provider-accounts', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { data: { accounts: Record<string, unknown>[] } };
    for (const account of body.data.accounts) {
      if (account.destinationProvider === 'fanvue') {
        account.capabilitySnapshot = { schemaVersion: 1, contentKinds: [], media: {} };
      }
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/w/${data.slug}/queue`);
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await page.getByRole('radio', { name: /Fanvue.*Fixture Creator/ }).click();
  await page.getByRole('button', { name: 'Who can see this post' }).click();
  await page.getByRole('option', { name: 'Subscribers', exact: true }).click();
  await page.getByLabel('Post body').fill('Blocked by capability snapshot');
  await expect(page.getByRole('button', { name: 'Schedule 1 post' })).toBeDisabled();
  expect(requests).toHaveLength(1);
});
