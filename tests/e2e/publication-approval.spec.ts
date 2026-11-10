import { expect, test } from '@playwright/test';

test('composer hold is default off and opt-in scheduling reaches Calendar', async ({
  page,
}, testInfo) => {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Composer Owner',
      email: `composer-approval-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Composer Approval ${suffix}`,
    },
  });
  expect(registered.ok()).toBe(true);
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'publish_relay_csrf',
  )?.value;
  if (!csrf) throw new Error('CSRF cookie missing');
  expect(
    (await page.request.post('/api/oauth/x', { headers: { 'x-csrf-token': csrf } })).ok(),
  ).toBe(true);
  const workspace = await page.request.get('/api/workspaces/current');
  const slug = ((await workspace.json()) as { data: { slug: string } }).data.slug;
  await page.goto(`/w/${slug}/queue`);
  await page.getByRole('button', { name: 'Create post' }).last().click();
  await page.getByRole('radio', { name: /Example Editorial/ }).click();
  const hold = page.getByRole('button', { name: /Require approval before publishing/ });
  await expect(hold).toHaveAttribute('aria-pressed', 'false');
  await hold.click();
  await expect(hold).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Post body').fill('Composer approval hold');
  await page.screenshot({ path: testInfo.outputPath('approval-composer.png') });
  await page.getByRole('button', { name: 'Create awaiting-approval post' }).click();
  await expect(page.getByRole('heading', { name: '1 post scheduled' })).toBeVisible();
  await page.goto(`/w/${slug}/queue`);
  await expect(page.getByText('Awaiting approval').first()).toBeVisible();
  await page.goto(`/w/${slug}/calendar`);
  await expect(page.getByText('Awaiting approval').first()).toBeVisible();
});

test('held publication survives reload, approves exact job and remains cancellable', async ({
  page,
}, testInfo) => {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Approval Owner',
      email: `approval-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Approval ${suffix}`,
    },
  });
  expect(registered.ok()).toBe(true);
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'publish_relay_csrf',
  )?.value;
  if (!csrf) throw new Error('CSRF cookie missing');
  const connected = await page.request.post('/api/oauth/x', { headers: { 'x-csrf-token': csrf } });
  expect(connected.ok()).toBe(true);
  const accounts = await page.request.get('/api/provider-accounts');
  expect(accounts.ok()).toBe(true);
  const accountBody = (await accounts.json()) as {
    data: { accounts: { id: string; displayName: string }[] };
  };
  const account = accountBody.data.accounts.find((candidate) =>
    candidate.displayName.includes('Example Editorial'),
  );
  if (!account) throw new Error('Fixture X account missing');
  const due = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const created = await page.request.post('/api/workflow/posts', {
    headers: { 'x-csrf-token': csrf, 'idempotency-key': `held-${suffix}` },
    data: {
      content: { type: 'text', text: 'Held for owner review' },
      providerAccountIds: [account.id],
      scheduledAt: due,
      approvalRequired: true,
    },
  });
  expect(created.status()).toBe(201);
  const jobId = ((await created.json()) as { data: { jobIds: string[] } }).data.jobIds[0];
  if (!jobId) throw new Error('Held job missing');
  const workspace = await page.request.get('/api/workspaces/current');
  const slug = ((await workspace.json()) as { data: { slug: string } }).data.slug;
  await page.goto(`/w/${slug}/jobs/${jobId}`);
  await expect(page.getByText('Awaiting approval').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve publication' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('approval-held.png') });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Approve publication' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve publication' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('approval-confirm.png') });
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve publication' }).click();
  await expect(page.getByRole('button', { name: 'Approve publication' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Approve publication' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel job' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel job' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel job' }).click();
  await page.reload();
  await expect(page.getByText('Cancelled').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('approval-cancelled.png') });
});
