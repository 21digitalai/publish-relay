import { expect, test } from '@playwright/test';

test('review inbox edits and dismisses without a provider send', async ({ page }, testInfo) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Review Owner',
      email: `review-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Review Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const proposalId = '00000000-0000-4000-8000-000000000301';
  let status = 'pending';
  let revision = 1;
  let text = 'Suggested reply';
  let sends = 0;
  await page.route('**/api/engagement-proposals**', async (route) => {
    const url = new URL(route.request().url());
    const request = route.request();
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as {
        expectedRevision: number;
        content: { text: string };
      };
      expect(body.expectedRevision).toBe(revision);
      text = body.content.text;
      revision += 1;
    } else if (url.pathname.endsWith('/dismiss')) {
      const body = request.postDataJSON() as { expectedRevision: number };
      expect(body.expectedRevision).toBe(revision);
      status = 'dismissed';
    }
    const detail = {
      id: proposalId,
      accountDisplayName: 'Mira Studio',
      provider: 'fanvue',
      kind: 'dm',
      sourceContext: { text: 'Hi there', authorLabel: 'Fan' },
      content: { text },
      revision,
      status,
    };
    const data = url.pathname.endsWith('/api/engagement-proposals')
      ? {
          items:
            status === 'pending'
              ? [
                  {
                    id: proposalId,
                    accountDisplayName: 'Mira Studio',
                    provider: 'fanvue',
                    kind: 'dm',
                    sourcePreview: 'Hi there',
                    contentPreview: text,
                    createdAt: '2026-10-25T12:00:00Z',
                  },
                ]
              : [],
          nextCursor: null,
        }
      : detail;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data, error: null }),
    });
  });
  await page.route('**/api/v1/fanvue/**', async (route) => {
    sends += 1;
    await route.abort();
  });
  await page.goto(`/w/${workspace.data.slug}/proposals`);
  await expect(page.getByRole('heading', { name: 'Proposed replies' })).toBeVisible();
  await page.getByRole('button', { name: /Fanvue message/ }).click();
  await expect(page.getByText('Destination: Mira Studio')).toBeVisible();
  await expect(page.getByText('Hi there')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('proposal-selected.png'), fullPage: true });
  await page.getByLabel('Suggested reply').fill('Revised reply');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved. No message was sent.')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Fanvue message/ }).click();
  await expect(page.getByLabel('Suggested reply')).toHaveValue('Revised reply');
  await page.getByRole('button', { name: 'Dismiss proposal' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('proposal-dismiss.png'), fullPage: true });
  await page.getByRole('button', { name: 'Dismiss proposal' }).last().click();
  await expect(page.getByText('No replies await review.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('No replies await review.')).toBeVisible();
  expect(sends).toBe(0);
});
