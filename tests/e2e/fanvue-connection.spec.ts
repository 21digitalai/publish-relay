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
  await page.route('https://auth.fanvue.com/**', (route) => {
    const auth = new URL(route.request().url());
    expect(auth.searchParams.get('scope')).not.toMatch(/chat|comment/);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    const state = auth.searchParams.get('state');
    if (!state) throw new Error('Fanvue authorization state was not present');
    return route.fulfill({
      status: 302,
      headers: {
        Location: `http://127.0.0.1:43199/api/oauth/fanvue/callback?state=${state}&code=fixture`,
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
  await page.reload();
  await expect(page.getByText('Fixture Creator').first()).toBeVisible();

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
});
