import { expect, test } from '@playwright/test';

test('closed Page DM window hides approval on desktop and mobile', async ({ page }, testInfo) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Closed Window Owner',
      email: `closed-window-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Closed Window Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const id = '00000000-0000-4000-8000-000000000414';
  const plannedDueAt = new Date(Date.now() - 60_000).toISOString();
  let status = 'expired';
  let windowState: 'closed' | 'stale' = 'closed';
  let approvals = 0;
  await page.route('**/api/engagement-proposals**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/approve') || path.endsWith('/approve-preview')) approvals += 1;
    const data = path.endsWith('/reply-window')
      ? { state: windowState }
      : path.endsWith('/api/engagement-proposals')
        ? {
            items: [
              {
                id,
                accountDisplayName: 'Eli Page',
                provider: 'facebook_page',
                kind: 'dm',
                status,
                plannedDueAt,
                sourcePreview: 'Hello',
                contentPreview: 'Draft',
                createdAt: new Date().toISOString(),
              },
            ],
            nextCursor: null,
          }
        : {
            id,
            accountDisplayName: 'Eli Page',
            provider: 'facebook_page',
            kind: 'dm',
            targetId: 't_123',
            sourceContext: { text: 'Hello' },
            content: { text: 'Draft', followUps: ['Second', 'Third'] },
            plannedDueAt,
            revision: 1,
            status,
            canApprove: true,
            noGo: false,
          };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data, error: null }),
    });
  });
  for (const size of [
    { width: 1280, height: 800, state: 'closed' as const },
    { width: 390, height: 844, state: 'closed' as const },
    { width: 390, height: 844, state: 'stale' as const },
  ]) {
    status = 'pending';
    windowState = size.state;
    await page.setViewportSize(size);
    await page.goto(`/w/${workspace.data.slug}/proposals`);
    await page.getByRole('button', { name: /Facebook Page message/ }).click();
    await expect(
      page.getByText(
        size.state === 'stale'
          ? 'Newer message arrived · fresh draft coming'
          : 'Reply window closed · waiting for their next message',
      ),
    ).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Approve and schedule 3 bubbles' })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Approve scheduled time' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Dismiss proposal' })).toBeVisible();
    await expect(page.getByLabel('Inactive drafts')).toContainText('Facebook Page message');
    await expect(page.locator('.engagement-reply-window-badge.danger')).toBeVisible();
    await expect(page.getByText(/approval re-anchors|Approval schedules from now/)).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`page-dm-${size.state}-${String(size.width)}.png`),
      fullPage: true,
    });
  }
  status = 'expired';
  await page.goto(`/w/${workspace.data.slug}/proposals`);
  await expect(page.getByLabel('Inactive drafts')).toContainText('Expired draft');
  await page.getByRole('button', { name: /Facebook Page message/ }).click();
  await expect(
    page.getByText('Expired draft. Dismiss it or wait for a fresh draft.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Approve and schedule/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dismiss proposal' })).toBeVisible();
  expect(approvals).toBe(0);
});

test('Page DM plan shows the verified window before approval', async ({ page }, testInfo) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Expired Review Owner',
      email: `expired-review-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Expired Review Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const id = '00000000-0000-4000-8000-000000000413';
  const plannedDueAt = new Date(Date.now() + 300_000).toISOString();
  let approvals = 0;
  let status = 'pending';
  const dueAt = new Date(Date.now() + 600_000).toISOString();
  const latestInboundAt = new Date(Date.now() - 3_600_000).toISOString();
  const previewedAt = new Date().toISOString();
  const latestInboundFingerprint = 'a'.repeat(64);
  await page.route('**/api/engagement-proposals**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/reply-window')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { state: 'open', latestInboundAt, windowDeadline: dueAt },
          error: null,
        }),
      });
      return;
    }
    if (path.endsWith('/approve-preview')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { dueAt, previewedAt, latestInboundFingerprint },
          error: null,
        }),
      });
      return;
    }
    if (path.endsWith('/approve')) {
      approvals += 1;
      expect(request.postDataJSON()).toEqual({
        expectedRevision: 1,
        sendMode: 'scheduled',
        dueAt,
        previewedAt,
        latestInboundFingerprint,
      });
      status = 'scheduled';
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { id, status, dueAt }, error: null }),
      });
      return;
    }
    const list = path.endsWith('/api/engagement-proposals');
    const data = list
      ? {
          items: [
            {
              id,
              accountDisplayName: 'Eli Page',
              provider: 'facebook_page',
              kind: 'dm',
              status,
              plannedDueAt,
              sourcePreview: 'Hello',
              contentPreview: 'Draft',
              createdAt: new Date().toISOString(),
            },
          ],
          nextCursor: null,
        }
      : {
          id,
          accountDisplayName: 'Eli Page',
          provider: 'facebook_page',
          kind: 'dm',
          targetId: 't_123',
          sourceContext: { text: 'Hello' },
          content: { text: 'Draft' },
          plannedDueAt,
          revision: 1,
          status,
          canApprove: true,
          noGo: false,
        };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data, error: null }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/proposals`);
  await expect(page.getByText('Reply window: select to check')).toBeVisible();
  await page.getByRole('button', { name: /Facebook Page message/ }).click();
  await expect(page.locator('.engagement-reply-window-badge')).toContainText(
    /Reply window: \d+h \d{2}m left/,
  );
  await expect(page.locator('.engagement-reply-window-detail')).toContainText(
    `Last message from recipient: ${new Date(latestInboundAt).toLocaleString()}`,
  );
  await expect(page.getByText('Edit the bubbles, then approve.')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('page-dm-window-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: /Facebook Page message/ }).click();
  await expect(page.locator('.engagement-reply-window-badge')).toBeVisible();
  await expect(page.locator('.engagement-reply-window-detail')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('page-dm-window-mobile.png'), fullPage: true });
  await expect(page.getByText(/approval adds the Page delay on top/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send immediately' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve and schedule', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText(new Date(dueAt).toLocaleString());
  expect(approvals).toBe(0);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve and schedule' }).click();
  await expect(page.getByText(/Reply scheduled for/)).toBeVisible();
  expect(approvals).toBe(1);
  status = 'superseded';
  await page.reload();
  await page.getByRole('button', { name: /Facebook Page message/ }).click();
  await expect(page.getByText(/A newer draft replaced this one/)).toBeVisible();
  await expect(page.getByLabel('Inactive drafts')).toContainText('Superseded by a newer draft');
  await expect(page.getByRole('button', { name: /Approve and schedule/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dismiss proposal' })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss proposal' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Dismiss proposal' }).click();
  await expect(page.getByText('No replies await review or reconciliation.')).toBeVisible();
});

test('one Page DM approval reviews and edits all three scheduled bubbles', async ({ page }) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Group Review Owner',
      email: `group-review-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Group Review Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const id = '00000000-0000-4000-8000-000000000412';
  const dueAt = new Date(Date.now() + 3_600_000).toISOString();
  const previewedAt = new Date().toISOString();
  const latestInboundFingerprint = 'a'.repeat(64);
  let revision = 1;
  let texts: [string, string, string] = ['Здрасти', 'Как си?', 'Играеш ли днес?'];
  let approvals = 0;
  await page.route('**/api/engagement-proposals**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/reply-window')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { state: 'open', latestInboundAt: new Date().toISOString(), windowDeadline: dueAt },
          error: null,
        }),
      });
      return;
    }
    if (path.endsWith('/approve-preview')) {
      expect(request.postDataJSON()).toEqual({ expectedRevision: 2 });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { dueAt, previewedAt, latestInboundFingerprint },
          error: null,
        }),
      });
      return;
    }
    if (path.endsWith('/approve')) {
      approvals += 1;
      expect(request.postDataJSON()).toEqual({
        expectedRevision: 2,
        sendMode: 'scheduled',
        dueAt,
        previewedAt,
        latestInboundFingerprint,
      });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { id, status: 'scheduled', dueAt }, error: null }),
      });
      return;
    }
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as {
        content: { text: string; followUps: [string, string] };
      };
      texts = [body.content.text, ...body.content.followUps];
      revision = 2;
    }
    const list = path.endsWith('/api/engagement-proposals');
    const data = list
      ? {
          items: [
            {
              id,
              accountDisplayName: 'Eli Page',
              provider: 'facebook_page',
              kind: 'dm',
              status: 'pending',
              sourcePreview: 'Здравей',
              contentPreview: texts[0],
              createdAt: new Date().toISOString(),
            },
          ],
          nextCursor: null,
        }
      : {
          id,
          accountDisplayName: 'Eli Page',
          provider: 'facebook_page',
          kind: 'dm',
          targetId: 't_123',
          sourceContext: { text: 'Здравей', authorLabel: 'Иван Иванов', sourceMessageId: 'mid_1' },
          content: { text: texts[0], followUps: [texts[1], texts[2]] },
          plannedDueAt: dueAt,
          revision,
          status: 'pending',
          canApprove: true,
          noGo: false,
          scheduleWindow: { earliestDelaySeconds: 300, latestDelaySeconds: 2700 },
        };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data, error: null }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/proposals`);
  await page.getByRole('button', { name: /Facebook Page message/ }).click();
  await expect(page.getByText('Иван Иванов:')).toBeVisible();
  await expect(page.getByText(/One approval schedules all three bubbles/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send immediately' })).toHaveCount(0);
  await page.getByLabel('Bubble 2').fill('Добре съм');
  await page.getByRole('button', { name: 'Save edits' }).click();
  await expect(page.getByLabel('Bubble 2')).toHaveValue('Добре съм');
  await page.getByRole('button', { name: 'Approve and schedule 3 bubbles' }).click();
  await expect(page.getByText('Approve and schedule all three bubbles?')).toBeVisible();
  await page.getByRole('button', { name: 'Approve and schedule', exact: true }).click();
  expect(approvals).toBe(1);
  expect(texts).toEqual(['Здрасти', 'Добре съм', 'Играеш ли днес?']);
});

test('Page DM history filters by recipient without showing raw conversation IDs', async ({
  page,
}) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'History Owner',
      email: `history-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'History Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  const queries: string[] = [];
  await page.route('**/api/facebook-page-dm-history**', async (route) => {
    const url = new URL(route.request().url());
    queries.push(url.search);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: [
            {
              id: '00000000-0000-4000-8000-000000000701',
              kind: 'send',
              accountId: '00000000-0000-4000-8000-000000000702',
              accountDisplayName: 'Eli Page',
              conversationId: 't_900',
              receiverLabel: 'Alexandra',
              status: 'confirmed',
              createdAt: '2026-11-05T09:00:00Z',
              updatedAt: '2026-11-05T09:00:00Z',
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/proposals`);
  await expect(page.getByRole('heading', { name: 'Page DM history' })).toBeVisible();
  await page.getByRole('button', { name: 'Alexandra', exact: true }).click();
  await expect.poll(() => queries.at(-1)).toContain('conversationId=t_900');
  await expect(page.getByText('t_900')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect.poll(() => queries.at(-1)).not.toContain('conversationId');
});

test('Page DM history ignores stale filter and load-more responses', async ({ page }) => {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'History Race Owner',
      email: `history-race-${String(Date.now())}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'History Race Studio',
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };
  let releaseFilter: (() => void) | undefined;
  let releaseMore: (() => void) | undefined;
  let filterStarted: (() => void) | undefined;
  let moreStarted: (() => void) | undefined;
  const filterSeen = new Promise<void>((resolve) => {
    filterStarted = resolve;
  });
  const moreSeen = new Promise<void>((resolve) => {
    moreStarted = resolve;
  });
  let requests = 0;
  const row = (label: string) => ({
    id:
      label === 'Alexandra'
        ? '00000000-0000-4000-8000-000000000701'
        : '00000000-0000-4000-8000-000000000703',
    kind: 'send',
    accountId: '00000000-0000-4000-8000-000000000702',
    accountDisplayName: 'Eli Page',
    conversationId: 't_900',
    receiverLabel: label,
    status: 'confirmed',
    createdAt: '2026-11-05T09:00:00Z',
    updatedAt: '2026-11-05T09:07:00Z',
  });
  await page.route('**/api/facebook-page-dm-history**', async (route) => {
    requests += 1;
    const current = requests;
    if (current === 2) {
      filterStarted?.();
      await new Promise<void>((resolve) => {
        releaseFilter = resolve;
      });
    }
    if (current === 4) {
      moreStarted?.();
      await new Promise<void>((resolve) => {
        releaseMore = resolve;
      });
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          items: [row(current === 2 || current === 4 ? 'Stale person' : 'Alexandra')],
          nextCursor: current === 1 || current === 3 ? 'more' : null,
        },
        error: null,
      }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/proposals`);
  await page.getByRole('button', { name: 'Alexandra', exact: true }).click();
  await filterSeen;
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect.poll(() => requests).toBe(3);
  releaseFilter?.();
  await expect(page.getByText('Stale person')).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more' }).click();
  await moreSeen;
  await page.getByRole('button', { name: 'Alexandra', exact: true }).click();
  await expect.poll(() => requests).toBe(5);
  releaseMore?.();
  await expect(page.getByText('Stale person')).toHaveCount(0);
  await expect(page.getByText(/Updated .*/)).toBeVisible();
});

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
    if (path.endsWith('/reply-window')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            state: 'open',
            latestInboundAt: new Date().toISOString(),
            windowDeadline: new Date(Date.now() + 3_600_000).toISOString(),
          },
          error: null,
        }),
      });
      return;
    }
    if (path.endsWith('/approve')) {
      approvals += 1;
      expect(request.postDataJSON()).toEqual(
        path.includes(commentId)
          ? { expectedRevision: 1 }
          : { expectedRevision: 1, sendMode: 'immediate' },
      );
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
  const dueAt = new Date(Date.now() + 3_600_000).toISOString();
  const previewedAt = new Date().toISOString();
  const latestInboundFingerprint = 'a'.repeat(64);
  let status = 'pending';
  let earliestDelaySeconds = 300;
  let latestDelaySeconds = 2700;
  let approvals = 0;
  await page.route('**/api/engagement-proposals**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data: unknown;
    if (path.endsWith('/reply-window')) {
      data = {
        state: 'open',
        latestInboundAt: new Date().toISOString(),
        windowDeadline: new Date(Date.now() + 3_600_000).toISOString(),
      };
    } else if (path.endsWith('/schedule-default') && request.method() === 'PUT') {
      const input = request.postDataJSON() as {
        earliestDelaySeconds: number;
        latestDelaySeconds: number;
      };
      earliestDelaySeconds = input.earliestDelaySeconds;
      latestDelaySeconds = input.latestDelaySeconds;
      data = input;
    } else if (path.endsWith('/approve-preview')) {
      data = { dueAt, previewedAt, latestInboundFingerprint };
    } else if (path.endsWith('/approve')) {
      approvals += 1;
      expect(request.postDataJSON()).toEqual({
        expectedRevision: 1,
        sendMode: 'scheduled',
        dueAt,
        previewedAt,
        latestInboundFingerprint,
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
        plannedDueAt: dueAt,
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
  await expect(page.locator('.engagement-planned-due-at')).toContainText(
    new Date(dueAt).toLocaleString(),
  );
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
  await page.getByRole('button', { name: 'Save edits' }).click();
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
