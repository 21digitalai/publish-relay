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
      canApprove: true,
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
                    status,
                    sourcePreview: 'Hi there',
                    contentPreview: text,
                    createdAt: '2026-10-25T12:00:00Z',
                  },
                ]
              : [],
          nextCursor: null,
        }
      : request.method() === 'PATCH'
        ? { ...detail, accountDisplayName: undefined }
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
  await expect(page.getByText('Destination: Mira Studio')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Fanvue message/ }).click();
  await expect(page.getByLabel('Suggested reply')).toHaveValue('Revised reply');
  await page.getByRole('button', { name: 'Dismiss proposal' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('proposal-dismiss.png'), fullPage: true });
  await page.getByRole('button', { name: 'Dismiss proposal' }).last().click();
  await expect(page.getByText('No replies await review or reconciliation.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('No replies await review or reconciliation.')).toBeVisible();
  expect(sends).toBe(0);
});

test('failed list and detail loads offer a retry instead of an empty or endless loading state', async ({
  page,
}) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Review Owner',
      email: `review-retry-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Review Retry Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  let listCalls = 0;
  let detailCalls = 0;
  await page.route('**/api/engagement-proposals**', async (route) => {
    const list = new URL(route.request().url()).pathname.endsWith('/api/engagement-proposals');
    const attempt = list ? ++listCalls : ++detailCalls;
    if (attempt === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: 'Temporarily unavailable' }),
      });
      return;
    }
    const data = list
      ? {
          items: [
            {
              id: '00000000-0000-4000-8000-000000000302',
              accountDisplayName: 'Mira Studio',
              provider: 'fanvue',
              kind: 'dm',
              status: 'pending',
              sourcePreview: 'Hi',
              contentPreview: 'Hello',
              createdAt: '2026-10-25T12:00:00Z',
            },
          ],
          nextCursor: null,
        }
      : {
          id: '00000000-0000-4000-8000-000000000302',
          accountDisplayName: 'Mira Studio',
          provider: 'fanvue',
          kind: 'dm',
          sourceContext: { text: 'Hi' },
          content: { text: 'Hello' },
          revision: 1,
          status: 'pending',
          canApprove: true,
        };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data, error: null }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/proposals`);
  await expect(page.getByRole('button', { name: 'Retry loading proposals' })).toBeVisible();
  await expect(page.getByText('No replies await review.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry loading proposals' }).click();
  await page.getByRole('button', { name: /Fanvue message/ }).click();
  await expect(page.getByRole('button', { name: 'Retry loading proposal' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry loading proposal' }).click();
  await expect(page.getByText('Destination: Mira Studio')).toBeVisible();
});

test('Fanvue text approval confirms once and removes the reply from the pending queue', async ({
  page,
}, testInfo) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Approval Owner',
      email: `approve-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Approval Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const proposalId = '00000000-0000-4000-8000-000000000303';
  let status = 'pending';
  let approvals = 0;
  await page.route('**/api/engagement-proposals**', async (route) => {
    const request = route.request();
    const list = new URL(request.url()).pathname.endsWith('/api/engagement-proposals');
    if (request.method() === 'POST' && request.url().endsWith('/approve')) {
      approvals += 1;
      expect(request.postDataJSON()).toEqual({ expectedRevision: 1 });
      status = 'sent';
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { id: proposalId, status }, error: null }),
      });
      return;
    }
    const data = list
      ? {
          items:
            status === 'pending'
              ? [
                  {
                    id: proposalId,
                    accountDisplayName: 'Mira Studio',
                    provider: 'fanvue',
                    kind: 'comment',
                    status,
                    sourcePreview: 'Nice work',
                    contentPreview: 'Thank you',
                    createdAt: '2026-10-25T12:00:00Z',
                  },
                ]
              : [],
          nextCursor: null,
        }
      : {
          id: proposalId,
          accountDisplayName: 'Mira Studio',
          provider: 'fanvue',
          kind: 'comment',
          targetId: '00000000-0000-4000-8000-000000000304',
          sourceContext: { text: 'Nice work' },
          content: { text: 'Thank you' },
          revision: 1,
          status,
          canApprove: true,
        };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data, error: null }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/proposals`);
  await page.getByRole('button', { name: /Fanvue comment/ }).click();
  const approve = page.getByRole('button', { name: 'Approve and send', exact: true });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('proposal-approval-confirm.png'),
    fullPage: true,
  });
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve and send' }).click();
  await expect(page.getByText('Reply sent through Fanvue.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve and send', exact: true })).toHaveCount(0);
  expect(approvals).toBe(1);
  await page.reload();
  await expect(page.getByText('No replies await review or reconciliation.')).toBeVisible();
});

test('unknown approval stays visible after reload without a resend control', async ({ page }) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Uncertain Owner',
      email: `uncertain-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Uncertain Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const proposalId = '00000000-0000-4000-8000-000000000305';
  let status = 'pending';
  let approvals = 0;
  await page.route('**/api/engagement-proposals**', async (route) => {
    const request = route.request();
    const list = new URL(request.url()).pathname.endsWith('/api/engagement-proposals');
    if (request.method() === 'POST' && request.url().endsWith('/approve')) {
      approvals += 1;
      status = 'unknown';
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ data: { id: proposalId, status }, error: null }),
      });
      return;
    }
    const data = list
      ? {
          items: [
            {
              id: proposalId,
              accountDisplayName: 'Mira Studio',
              provider: 'fanvue',
              kind: 'dm',
              status,
              sourcePreview: 'Hello',
              contentPreview: 'Hi',
              createdAt: '2026-10-25T12:00:00Z',
            },
          ],
          nextCursor: null,
        }
      : {
          id: proposalId,
          accountDisplayName: 'Mira Studio',
          provider: 'fanvue',
          kind: 'dm',
          targetId: '00000000-0000-4000-8000-000000000306',
          sourceContext: { text: 'Hello' },
          content: { text: 'Hi' },
          revision: 1,
          status,
          canApprove: true,
        };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data, error: null }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/proposals`);
  await page.getByRole('button', { name: /Fanvue message/ }).click();
  await page.getByRole('button', { name: 'Approve and send', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve and send' }).click();
  await expect(page.getByText(/Send outcome is unknown/).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText('Send outcome unknown')).toBeVisible();
  await page.getByRole('button', { name: /Fanvue message/ }).click();
  await expect(page.getByRole('button', { name: 'Approve and send', exact: true })).toHaveCount(0);
  expect(approvals).toBe(1);
});
