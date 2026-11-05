import { expect, test } from '@playwright/test';

test('Facebook Page proposals use the shared review panel on desktop and mobile', async ({
  page,
}, testInfo) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Page Review Owner',
      email: `page-review-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Page Review Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const commentId = '00000000-0000-4000-8000-000000000411';
  const dmId = '00000000-0000-4000-8000-000000000412';
  let sentComment = false;
  let dmUnknown = false;
  let approvals = 0;
  await page.route('**/api/engagement-proposals**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/approve')) {
      approvals += 1;
      expect(request.postDataJSON()).toEqual({ expectedRevision: 1 });
      if (path.includes(commentId)) sentComment = true;
      else dmUnknown = true;
      await route.fulfill({
        status: path.includes(commentId) ? 200 : 202,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: path.includes(commentId) ? commentId : dmId,
            status: path.includes(commentId) ? 'sent' : 'unknown',
          },
          error: null,
        }),
      });
      return;
    }
    const list = path.endsWith('/api/engagement-proposals');
    const id = path.includes(commentId) ? commentId : dmId;
    const data = list
      ? {
          items: [
            ...(!sentComment
              ? [
                  {
                    id: commentId,
                    accountDisplayName: 'Eli Page',
                    provider: 'facebook_page',
                    kind: 'comment',
                    status: 'pending',
                    sourcePreview: 'Visitor comment',
                    contentPreview: 'Thanks',
                    createdAt: '2026-10-26T12:01:00Z',
                  },
                ]
              : []),
            {
              id: dmId,
              accountDisplayName: 'Eli Page',
              provider: 'facebook_page',
              kind: 'dm',
              status: dmUnknown ? 'unknown' : 'pending',
              sourcePreview: 'Inbound message',
              contentPreview: 'Hello',
              createdAt: '2026-10-26T12:00:00Z',
            },
          ],
          nextCursor: null,
        }
      : {
          id,
          accountDisplayName: 'Eli Page',
          provider: 'facebook_page',
          kind: id === commentId ? 'comment' : 'dm',
          targetId: id === commentId ? '900_2' : 't_900',
          sourceContext:
            id === commentId
              ? { text: 'Visitor comment', postId: '900_1' }
              : { text: 'Inbound message', sourceMessageId: 'mid_1' },
          content: { text: id === commentId ? 'Thanks' : 'Hello' },
          revision: 1,
          status: id === commentId ? 'pending' : dmUnknown ? 'unknown' : 'pending',
          canApprove: true,
        };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data, error: null }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/proposals`);
  await page.getByRole('button', { name: /Facebook Page comment/ }).click();
  await expect(page.getByRole('button', { name: 'Approve and send', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('facebook-comment-ready.png') });
  await page.getByRole('button', { name: 'Approve and send', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Eli Page');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve and send' }).click();
  await expect(page.getByText('Reply sent through Facebook Page.')).toBeVisible();
  await page.getByRole('button', { name: /Facebook Page message/ }).click();
  await page.getByRole('button', { name: 'Send immediately' }).click();
  await expect(page.getByRole('button', { name: 'Approve and send', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Approve and send', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve and send' }).click();
  await expect(page.getByText(/Send outcome is unknown/).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('facebook-dm-unknown.png') });
  await page.reload();
  await page.getByRole('button', { name: /Facebook Page message/ }).click();
  await expect(page.getByRole('button', { name: 'Approve and send', exact: true })).toHaveCount(0);
  expect(approvals).toBe(2);
});

test('Page DM timing persists per Page and scheduled approval can be cancelled before dispatch', async ({
  page,
}, testInfo) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Scheduling Owner',
      email: `page-schedule-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Page Scheduling Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const id = '00000000-0000-4000-8000-000000000721';
  const dueAt = '2026-11-05T14:20:00.000Z';
  let status = 'pending';
  let earliestDelaySeconds = 300;
  let latestDelaySeconds = 2700;
  let approvals = 0;
  await page.route('**/api/engagement-proposals**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data: unknown;
    if (path.endsWith('/schedule-default') && request.method() === 'PUT') {
      const input = request.postDataJSON() as {
        earliestDelaySeconds: number;
        latestDelaySeconds: number;
      };
      earliestDelaySeconds = input.earliestDelaySeconds;
      latestDelaySeconds = input.latestDelaySeconds;
      data = input;
    } else if (path.endsWith('/approve')) {
      approvals += 1;
      expect(request.postDataJSON()).toEqual({
        expectedRevision: 1,
        schedule: { earliestDelaySeconds: 600, latestDelaySeconds: 5400 },
      });
      status = 'scheduled';
      data = { id, status, dueAt };
    } else if (path.endsWith('/cancel-scheduled')) {
      status = 'cancelled';
      data = { status };
    } else if (path.endsWith('/api/engagement-proposals')) {
      data = {
        items:
          status === 'cancelled'
            ? []
            : [
                {
                  id,
                  accountDisplayName: 'Eli Page',
                  provider: 'facebook_page',
                  kind: 'dm',
                  status,
                  sourcePreview: 'Hello',
                  contentPreview: 'A reply',
                  createdAt: '2026-11-05T12:00:00Z',
                },
              ],
        nextCursor: null,
      };
    } else {
      data = {
        id,
        accountDisplayName: 'Eli Page',
        provider: 'facebook_page',
        kind: 'dm',
        targetId: 't_900',
        sourceContext: { authorLabel: 'Ivan', text: 'Hello' },
        content: { text: 'A reply' },
        revision: 1,
        status,
        canApprove: true,
        noGo: false,
        scheduleWindow: { earliestDelaySeconds, latestDelaySeconds },
        schedule: status === 'scheduled' ? { dueAt, status: 'pending' } : null,
      };
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data, error: null }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/proposals`);
  await page.getByRole('button', { name: /Facebook Page message/ }).click();
  await expect(page.getByText('Default for this Page: 5–45 minutes.')).toBeVisible();
  await page.locator('#engagement-delay-min').selectOption('10');
  await page.locator('#engagement-delay-max').selectOption('90');
  await page.getByRole('button', { name: 'Save Page timing' }).click();
  await page.reload();
  await page.getByRole('button', { name: /Facebook Page message/ }).click();
  await expect(page.getByText('Default for this Page: 10–90 minutes.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('page-dm-scheduled-ready.png') });
  await page.getByRole('button', { name: 'Approve and schedule', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Ivan');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve and schedule' }).click();
  await expect(page.getByText(/Scheduled for/).first()).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Facebook Page message/ }).click();
  await expect(page.getByRole('button', { name: 'Cancel scheduled reply' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('page-dm-scheduled-pending.png') });
  await page.getByRole('button', { name: 'Cancel scheduled reply' }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Cancel scheduled reply' })
    .click();
  await expect(
    page.getByText('Scheduled reply cancelled before dispatch. No message was sent.'),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText('No replies await review or reconciliation.')).toBeVisible();
  expect(approvals).toBe(1);
});

test('Page DM no-go block survives reload and can be removed from the list', async ({ page }) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'No Go Owner',
      email: `no-go-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'No Go Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const id = '00000000-0000-4000-8000-000000000601';
  const accountId = '00000000-0000-4000-8000-000000000602';
  let blocked = false;
  await page.route('**/api/facebook-page-dm-no-go**', async (route) => {
    if (route.request().method() === 'DELETE') blocked = false;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data:
          route.request().method() === 'GET'
            ? {
                canManage: true,
                items: blocked
                  ? [
                      {
                        accountId,
                        conversationId: 't_900',
                        displayName: 'Alexandra',
                        accountDisplayName: 'Eli Page',
                        createdAt: '2026-11-05T09:00:00Z',
                      },
                    ]
                  : [],
              }
            : { noGo: false },
        error: null,
      }),
    });
  });
  await page.route('**/api/engagement-proposals**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/no-go')) blocked = route.request().method() === 'POST';
    const data = path.endsWith('/api/engagement-proposals')
      ? {
          items: [
            {
              id,
              accountDisplayName: 'Eli Page',
              provider: 'facebook_page',
              kind: 'dm',
              status: blocked ? 'dismissed' : 'pending',
              sourcePreview: 'Hello',
              contentPreview: 'Hi',
              createdAt: '2026-11-05T09:00:00Z',
            },
          ],
          nextCursor: null,
        }
      : path.endsWith('/no-go')
        ? { noGo: blocked }
        : {
            id,
            accountId,
            accountDisplayName: 'Eli Page',
            provider: 'facebook_page',
            kind: 'dm',
            targetId: 't_900',
            sourceContext: { authorLabel: 'Alexandra', text: 'Hello' },
            content: { text: 'Hi' },
            revision: 1,
            status: blocked ? 'dismissed' : 'pending',
            canApprove: true,
            noGo: blocked,
          };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data, error: null }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/proposals`);
  await page.getByRole('button', { name: /Facebook Page message/ }).click();
  await page.getByRole('button', { name: 'Do not message this person' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Block and dismiss' }).click();
  await expect(
    page.getByText('No-go conversation: new proposals and sends are blocked.'),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText('Alexandra · Eli Page')).toBeVisible();
  await page.getByRole('button', { name: 'Allow messages' }).click();
  await expect(page.getByText('No Page conversations are blocked.')).toBeVisible();
});

test('late stage result from another proposal cannot unlock reused media', async ({ page }) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Race Review Owner',
      email: `race-review-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Race Review Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const firstId = '00000000-0000-4000-8000-000000000381';
  const secondId = '00000000-0000-4000-8000-000000000382';
  const mediaId = '00000000-0000-4000-8000-000000000383';
  const targetId = '00000000-0000-4000-8000-000000000384';
  let releaseFirst: (() => void) | undefined;
  let firstStarted = false;
  await page.route('**/api/engagement-proposals**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/stage')) {
      if (path.includes(firstId)) {
        firstStarted = true;
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { state: 'ready' },
          error: null,
        }),
      });
      return;
    }
    const list = path.endsWith('/api/engagement-proposals');
    const ids = [firstId, secondId];
    const data = list
      ? {
          items: ids.map((id, index) => ({
            id,
            accountDisplayName: 'Mira Studio',
            provider: 'fanvue',
            kind: 'dm',
            status: 'pending',
            sourcePreview: 'Hi',
            contentPreview: `Proposal ${String(index + 1)}`,
            createdAt: '2026-10-25T12:00:00Z',
          })),
          nextCursor: null,
        }
      : {
          id: path.includes(firstId) ? firstId : secondId,
          accountDisplayName: 'Mira Studio',
          provider: 'fanvue',
          kind: 'dm',
          targetId,
          sourceContext: { text: 'Hi' },
          content: { text: 'Reply', mediaIds: [mediaId] },
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
  await page.getByRole('button', { name: /Proposal 1/ }).click();
  await page.getByRole('button', { name: 'Prepare attachment' }).click();
  await expect.poll(() => firstStarted).toBe(true);
  await page.getByRole('button', { name: /Proposal 2/ }).click();
  releaseFirst?.();
  await expect(page.getByText('Not prepared for sending')).toBeVisible();
  const approve = page.getByRole('button', { name: 'Approve and send', exact: true });
  await expect(approve).toBeDisabled();
  await page.getByRole('button', { name: 'Prepare attachment' }).click();
  await expect(page.getByText('Ready to send')).toBeVisible();
  await expect(approve).toBeEnabled();
});

test('priced Fanvue DM media requires explicit ready staging before approval', async ({
  page,
}, testInfo) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Media Review Owner',
      email: `media-review-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Media Review Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const proposalId = '00000000-0000-4000-8000-000000000391';
  const mediaId = '00000000-0000-4000-8000-000000000392';
  const targetId = '00000000-0000-4000-8000-000000000393';
  let stateIndex = 0;
  let approvals = 0;
  await page.route('**/api/engagement-proposals**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/stage')) {
      expect(request.postDataJSON()).toEqual({ expectedRevision: 1 });
      const state = ['uploading', 'processing', 'ready'][Math.min(stateIndex++, 2)];
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { state }, error: null }),
      });
      return;
    }
    if (path.endsWith('/approve')) {
      approvals += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { id: proposalId, status: 'sent' },
          error: null,
        }),
      });
      return;
    }
    const list = path.endsWith('/api/engagement-proposals');
    const data = list
      ? {
          items: [
            {
              id: proposalId,
              accountDisplayName: 'Mira Studio',
              provider: 'fanvue',
              kind: 'dm',
              status: 'pending',
              sourcePreview: 'Hi',
              contentPreview: 'Unlock',
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
          targetId,
          sourceContext: { text: 'Hi' },
          content: { text: 'Unlock', mediaIds: [mediaId], priceCents: 300 },
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
  await page.getByRole('button', { name: /Fanvue message/ }).click();
  const approve = page.getByRole('button', { name: 'Approve and send', exact: true });
  await expect(approve).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Preview attachment 1' })).toHaveAttribute(
    'href',
    `/api/workflow/media/${mediaId}`,
  );
  for (const state of ['More preparation needed', 'Processing at Fanvue', 'Ready to send']) {
    await page.getByRole('button', { name: 'Prepare attachment' }).click();
    await expect(page.getByText(state)).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath('priced-media-ready.png'), fullPage: true });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByRole('alertdialog')).toContainText('$3.00 unlock price');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve and send' }).click();
  await expect(page.getByText('Reply sent through Fanvue.')).toBeVisible();
  expect(approvals).toBe(1);
});

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
