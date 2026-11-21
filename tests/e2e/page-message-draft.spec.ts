import { expect, test, type Page } from '@playwright/test';

const accountId = '00000000-0000-4000-8000-000000000001';
const proposalId = '00000000-0000-4000-8000-000000000002';
async function setup(
  page: Page,
  options: {
    closed?: boolean;
    failSaveOnce?: boolean;
    changedSource?: boolean;
    rejectSave?: boolean;
  } = {},
) {
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Manual reviewer',
      email: `manual-${crypto.randomUUID()}@example.test`,
      password: 'long-password-123!',
      workspaceName: 'Manual Review',
    },
  });
  expect(registered.ok()).toBe(true);
  const { data: workspace } = (await (
    await page.request.get('/api/workspaces/current')
  ).json()) as { data: { slug: string } };
  const createdAt = new Date(Date.now() - (options.closed ? 86400000 : 60000)).toISOString();
  const writes: Record<string, unknown>[] = [];
  let sent = 0;
  let messageReads = 0;
  await page.route('**/api/provider-accounts**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/messages')) messageReads += 1;
    const data = path.endsWith('/messages')
      ? {
          participantId: 'tester',
          displayName: 'Shiro Tester',
          messages: [
            {
              id: options.changedSource && messageReads > 1 ? 'inbound-2' : 'inbound-1',
              senderId: 'tester',
              text: 'Fresh review message',
              createdAt,
            },
          ],
          nextCursor: null,
        }
      : path.endsWith('/facebook-conversations')
        ? {
            conversations: [
              { id: 'thread_1', displayName: 'Shiro Tester', noGo: false, terminal: false },
            ],
            nextCursor: null,
          }
        : {
            accounts: [
              { id: accountId, destinationProvider: 'facebook_page', displayName: '21Digital' },
            ],
            nextCursor: null,
          };
    await route.fulfill({ json: { data, error: null } });
  });
  await page.route('**/api/engagement-proposals**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/approve')) {
      sent += 1;
      return route.fulfill({ status: 500, json: { error: 'Must not send' } });
    }
    if (request.method() === 'POST' && path === '/api/engagement-proposals') {
      writes.push(request.postDataJSON() as Record<string, unknown>);
      expect(request.headers()['x-csrf-token']).toBeTruthy();
      if (options.rejectSave)
        return route.fulfill({
          status: 409,
          json: {
            data: null,
            error: 'This conversation already has an active or unresolved proposal',
          },
        });
      if (options.failSaveOnce && writes.length === 1) return route.abort('failed');
      return route.fulfill({ status: 201, json: { data: { id: proposalId }, error: null } });
    }
    if (path.endsWith('/reply-window'))
      return route.fulfill({
        json: {
          data: {
            state: 'open',
            latestInboundAt: createdAt,
            windowDeadline: new Date(Date.now() + 3600000).toISOString(),
          },
          error: null,
        },
      });
    if (path === `/api/engagement-proposals/${proposalId}`)
      return route.fulfill({
        json: {
          data: {
            id: proposalId,
            accountId,
            accountDisplayName: '21Digital',
            provider: 'facebook_page',
            kind: 'dm',
            targetId: 'thread_1',
            sourceContext: { text: 'Fresh review message', authorLabel: 'Shiro Tester' },
            content: { text: 'Manual test reply' },
            status: 'pending',
            revision: 1,
            canApprove: false,
            noGo: false,
          },
          error: null,
        },
      });
    return route.fulfill({ json: { data: { items: [], nextCursor: null }, error: null } });
  });
  await page.goto(`/w/${workspace.slug}/proposals`);
  await page.getByRole('button', { name: 'New Messenger reply', exact: true }).click();
  await page.getByRole('button', { name: '21Digital', exact: true }).click();
  await page.getByRole('button', { name: 'Shiro Tester', exact: true }).click();
  return { writes, sent: () => sent };
}

test('fresh Page message becomes an ordinary manual-approval draft without sending', async ({
  page,
}, testInfo) => {
  const state = await setup(page);
  await expect(page.locator('.page-message-draft-source')).toContainText('Fresh review message');
  await page.getByLabel('Your reply draft').fill('Manual test reply');
  await page.screenshot({ path: testInfo.outputPath('manual-message-draft.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save reply draft', exact: true }).click();
  await expect(
    page.getByText('Reply draft saved. Review and approve it separately; no message was sent.'),
  ).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    accountId,
    provider: 'facebook_page',
    kind: 'dm',
    targetId: 'thread_1',
    sourceContext: {
      sourceMessageId: 'inbound-1',
      text: 'Fresh review message',
      authorLabel: 'Shiro Tester',
    },
    content: { text: 'Manual test reply' },
  });
  expect(state.sent()).toBe(0);
  await page.reload();
  expect(state.writes).toHaveLength(1);
});

test('closed window shows actionable state and cannot create a reply', async ({ page }) => {
  const state = await setup(page, { closed: true });
  await expect(
    page.getByText('No recent, unambiguous incoming text message', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('Your reply draft')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save reply draft', exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(0);
  expect(state.sent()).toBe(0);
});

test('ambiguous save retries the exact same idempotent draft and never sends', async ({ page }) => {
  const state = await setup(page, { failSaveOnce: true });
  await page.getByLabel('Your reply draft').fill('Manual test reply');
  await page.getByRole('button', { name: 'Save reply draft', exact: true }).click();
  await expect(page.getByLabel('Your reply draft')).toBeDisabled();
  await page.getByRole('button', { name: 'Retry same draft', exact: true }).click();
  await expect(
    page.getByText('Reply draft saved. Review and approve it separately; no message was sent.'),
  ).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  expect(state.sent()).toBe(0);
});

test('source refresh prevents saving against a replaced incoming message', async ({ page }) => {
  const state = await setup(page, { changedSource: true });
  await page.getByLabel('Your reply draft').fill('Manual test reply');
  await page.getByRole('button', { name: 'Save reply draft', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('incoming message changed');
  expect(state.writes).toHaveLength(0);
  expect(state.sent()).toBe(0);
});

test('definite save rejection keeps the draft editable instead of claiming an unknown result', async ({
  page,
}) => {
  await setup(page, { rejectSave: true });
  await page.getByLabel('Your reply draft').fill('Manual test reply');
  await page.getByRole('button', { name: 'Save reply draft', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already has an active');
  await expect(page.getByLabel('Your reply draft')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Retry same draft', exact: true })).toHaveCount(0);
});

test('read permission failure is visible and a deliberate reload can recover', async ({ page }) => {
  const state = await setup(page);
  await page.route(
    '**/facebook-conversations/**/messages?*',
    (route) =>
      route.fulfill({
        status: 403,
        json: { data: null, error: 'Page read permission unavailable' },
      }),
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Page read permission unavailable');
  await page.getByRole('button', { name: 'Shiro Tester', exact: true }).click();
  await expect(page.locator('.page-message-draft-source')).toContainText('Fresh review message');
  expect(state.writes).toHaveLength(0);
  expect(state.sent()).toBe(0);
});
