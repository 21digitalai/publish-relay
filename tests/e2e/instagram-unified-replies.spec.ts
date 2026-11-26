import { expect, test } from '@playwright/test';

const accountId = '00000000-0000-4000-8000-000000000981';

test('Unified Instagram manual replies expose confirmation and bounded outcome states', async ({
  page,
}, testInfo) => {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  let permissionState = { instagram_basic: 'granted', instagram_manage_comments: 'granted' };
  let statusDelayMs = 0;
  let mediaMode: 'ready' | 'empty' | 'error' = 'ready';
  let dmFailure = true;
  let scheduledItems: Array<{
    id: string;
    kind: 'comment_reply' | 'dm_reply';
    text: string;
    dueAt: string;
    status: string;
  }> = [];
  const registered = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Unified Reply Owner',
      email: `unified-reply-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `Unified Reply ${suffix}`,
    },
  });
  expect(registered.ok()).toBe(true);
  const workspace = (await (await page.request.get('/api/workspaces/current')).json()) as {
    data: { slug: string };
  };

  await page.route('**/api/provider-accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          accounts: [
            {
              id: accountId,
              provider: 'instagram_unified_login',
              connectionFamily: 'instagram_unified_login',
              destinationProvider: 'instagram',
              name: 'Unified Studio',
              displayName: 'Unified Studio',
              status: 'active',
              availability: 'active',
              capabilityFreshness: 'fresh',
              capabilitySnapshot: { contentKinds: ['text'] },
              adapterDefaults: {},
            },
          ],
          nextCursor: null,
        },
        error: null,
      }),
    }),
  );
  await page.route(`**/api/provider-accounts/${accountId}/instagram-unified/status`, (route) =>
    (async () => {
      if (statusDelayMs) await new Promise((resolve) => setTimeout(resolve, statusDelayMs));
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: permissionState, error: null }),
      });
    })(),
  );
  await page.route(`**/api/provider-accounts/${accountId}/instagram-unified-media*`, (route) =>
    route.fulfill({
      status: mediaMode === 'error' ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        mediaMode === 'error'
          ? { data: null, error: 'Synthetic provider unavailable' }
          : {
              data: {
                media:
                  mediaMode === 'empty'
                    ? []
                    : [
                        {
                          id: 'media-1',
                          caption: 'Launch post',
                          timestamp: '2026-11-26T18:00:00Z',
                        },
                      ],
              },
              error: null,
            },
      ),
    }),
  );
  await page.route(`**/api/provider-accounts/${accountId}/instagram-unified-comments/*`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: { comments: [{ id: 'comment-1', text: 'Is this available?', username: 'alice' }] },
        error: null,
      }),
    }),
  );
  await page.route(
    `**/api/provider-accounts/${accountId}/instagram-unified-conversations*`,
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            conversations: [
              {
                id: 'conversation-1',
                updatedAt: '2026-11-26T18:30:00Z',
                participants: [
                  { id: accountId, username: 'unifiedstudio' },
                  { id: 'person-1', username: 'alice' },
                ],
              },
            ],
          },
          error: null,
        }),
      }),
  );
  await page.route(
    `**/api/provider-accounts/${accountId}/instagram-unified-conversations/conversation-1/messages*`,
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            messages: [
              {
                id: 'message-1',
                createdAt: '2026-11-26T18:29:00Z',
                senderId: 'person-1',
                senderUsername: 'alice',
                text: 'Can you tell me more?',
              },
            ],
          },
          error: null,
        }),
      }),
  );
  await page.route(
    `**/api/provider-accounts/${accountId}/instagram-unified-actions`,
    async (route) => {
      const payload = route.request().postDataJSON() as { kind?: string };
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data:
            payload.kind === 'dm_reply' && !dmFailure
              ? { state: 'confirmed', receipt: 'dm-receipt-1' }
              : payload.kind === 'dm_reply'
                ? null
                : { state: 'unknown' },
          error:
            payload.kind === 'dm_reply' && dmFailure ? 'Synthetic provider rejected reply' : null,
        }),
      });
      if (payload.kind === 'dm_reply') dmFailure = false;
    },
  );
  await page.route(
    `**/api/provider-accounts/${accountId}/instagram-unified-schedules**`,
    async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ data: { items: scheduledItems }, error: null }),
        });
        return;
      }
      if (method === 'POST') {
        const payload = route.request().postDataJSON() as {
          kind: 'comment_reply' | 'dm_reply';
          text: string;
          dueAt: string;
        };
        const item = {
          id: `scheduled-${scheduledItems.length + 1}`,
          ...payload,
          status: 'pending',
        };
        scheduledItems = [item];
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ data: item, error: null }),
        });
        return;
      }
      if (method === 'DELETE') {
        scheduledItems = scheduledItems.map((item) => ({ ...item, status: 'cancelled' }));
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ data: { cancelled: true }, error: null }),
        });
        return;
      }
      await route.fallback();
    },
  );

  await page.goto(`/w/${workspace.data.slug}/accounts`);
  const account = page.locator('.account-row').first();
  await account.getByRole('button', { name: 'Manage', exact: true }).click();
  const control = page.getByRole('region', { name: 'Unified Instagram capabilities' });
  await expect(control).toBeVisible();
  await expect(control.getByText('Verified').first()).toBeVisible();
  await control.getByRole('button', { name: 'Load recent posts' }).click();
  await expect(control.getByRole('button', { name: 'Post' })).toBeVisible();
  await expect(control.getByRole('button', { name: 'Comment' })).toBeVisible();
  await control.getByRole('textbox', { name: 'Reply' }).fill('Thanks for asking!');
  const future = new Date(Date.now() + 10 * 60 * 1000);
  const futureLocal = new Date(future.getTime() - future.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  await control.locator('input[type="datetime-local"]').fill(futureLocal);
  await control.getByRole('button', { name: 'Schedule reply' }).click();
  await expect(control).toContainText('pending · Thanks for asking!');
  await control.getByRole('button', { name: 'Cancel' }).click();
  await expect(control).toContainText('cancelled · Thanks for asking!');
  await control.getByRole('textbox', { name: 'Reply' }).fill('Thanks for asking!');
  await control.getByRole('button', { name: 'Send reply' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Confirm comment reply' });
  await expect(dialog).toContainText('Unified Studio');
  await expect(dialog).toContainText('Thanks for asking!');
  await page.screenshot({ path: testInfo.outputPath('instagram-unified-reply-desktop.png') });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await control.getByRole('button', { name: 'Send reply' }).click();
  await dialog.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(
    control.getByText('Reply outcome is unknown; do not resend automatically.'),
  ).toBeVisible();

  await control.getByRole('tab', { name: 'Conversation reply' }).click();
  await control.getByRole('button', { name: 'Load conversations' }).click();
  const conversationSelect = control.getByRole('button', { name: 'Conversation', exact: true });
  await expect(conversationSelect).toBeVisible();
  await conversationSelect.click();
  await expect(control.getByRole('option', { name: /alice/ })).toBeVisible();
  await control.getByRole('option', { name: /alice/ }).click();
  await control.getByRole('textbox', { name: 'Reply' }).fill('Absolutely, here are the details.');
  await control.getByRole('button', { name: 'Send reply' }).click();
  const dmDialog = page.getByRole('alertdialog', { name: 'Confirm conversation reply' });
  await expect(dmDialog).toContainText('alice');
  await expect(dmDialog).toContainText('Absolutely, here are the details.');
  await dmDialog.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(control.getByRole('alert')).toContainText('Synthetic provider rejected reply');
  await control.getByRole('button', { name: 'Send reply' }).click();
  await control
    .getByRole('alertdialog', { name: 'Confirm conversation reply' })
    .getByRole('button', {
      name: 'Confirm and send',
    })
    .click();
  await expect(control.getByText('Reply confirmed by the provider.')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('instagram-unified-reply-mobile.png') });

  permissionState = { instagram_basic: 'declined', instagram_manage_comments: 'declined' };
  statusDelayMs = 100;
  await control.getByRole('button', { name: 'Refresh status' }).click();
  await expect(control.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  await expect(control.getByText('Declined').first()).toBeVisible();

  mediaMode = 'empty';
  await control.getByRole('tab', { name: 'Comment reply' }).click();
  await control.getByRole('button', { name: 'Load recent posts' }).click();
  await expect(control.getByRole('button', { name: /Launch post/ })).toHaveCount(0);
  mediaMode = 'error';
  await control.getByRole('button', { name: 'Load recent posts' }).click();
  await expect(control.getByRole('alert')).toContainText('Synthetic provider unavailable');
});
