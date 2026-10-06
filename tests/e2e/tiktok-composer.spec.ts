import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import type { ImportedDraftMedia } from '../../src/ui/tiktok-composer.js';

const TIKTOK_ONE = '00000000-0000-4000-8000-000000000301';
const TIKTOK_TWO = '00000000-0000-4000-8000-000000000302';
const X_ACCOUNT = '00000000-0000-4000-8000-000000000303';
const IMPORTED_DRAFT = '00000000-0000-4000-8000-000000000304';
const IMPORTED_IMAGE = '00000000-0000-4000-8000-000000000305';
const IMPORTED_VIDEO = '00000000-0000-4000-8000-000000000306';

test('imported TikTok media is identified, removable, and replaceable on desktop and mobile', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const scope = window as typeof window & { __relayErrorHooks: unknown[] };
    scope.__relayErrorHooks = [];
    window.addEventListener('publish-relay-analytics', (event) => {
      const detail = (event as CustomEvent<{ type: string }>).detail;
      if (detail.type === 'user_error_shown') scope.__relayErrorHooks.push(detail);
    });
  });
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registration = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Relay Owner',
      email: `tiktok-import-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `TikTok import ${suffix}`,
    },
  });
  expect(registration.ok()).toBe(true);
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
              id: TIKTOK_ONE,
              provider: 'tiktok',
              displayName: 'TikTok One',
              status: 'active',
              availability: 'active',
            },
          ],
        },
        error: null,
      }),
    }),
  );
  await page.route('**/api/provider-accounts/*/tiktok-capabilities', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: '00000000-0000-4000-8000-000000000399',
          accountId: TIKTOK_ONE,
          nickname: 'Fresh Creator',
          privacyOptions: ['SELF_ONLY'],
          commentDisabled: false,
          duetDisabled: false,
          stitchDisabled: false,
          maxVideoDurationSeconds: 60,
          fetchedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 900000).toISOString(),
        },
        error: null,
      }),
    }),
  );
  let media: ImportedDraftMedia[] = [
    {
      id: IMPORTED_IMAGE,
      mimeType: 'image/jpeg',
      byteSize: 1000,
      durationMs: null,
      ready: true,
      previewUrl: `/api/workflow/media/${IMPORTED_IMAGE}`,
    },
    {
      id: IMPORTED_VIDEO,
      mimeType: 'video/mp4',
      byteSize: 3500,
      durationMs: 1000,
      ready: true,
      previewUrl: `/api/workflow/media/${IMPORTED_VIDEO}`,
    },
  ];
  await page.route(`**/api/workflow/drafts/${IMPORTED_DRAFT}`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: IMPORTED_DRAFT,
          label: 'Imported campaign',
          mediaIds: media.map((item) => item.id),
          media,
          postId: null,
        },
        error: null,
      }),
    }),
  );
  const video = readFileSync(new URL('../fixtures/tiktok-preview.mp4', import.meta.url));
  await page.route(`**/api/workflow/media/${IMPORTED_VIDEO}`, (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: video }),
  );
  await page.route('**/api/workflow/jobs?**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: '{"data":{"items":[],"next":null},"error":null}',
    }),
  );
  await page.goto(`/w/${workspace.data.slug}/drafts/${IMPORTED_DRAFT}`);
  await page.getByRole('checkbox', { name: /TikTok One/ }).check();
  await expect(page.getByText('This draft has multiple media items')).toBeVisible();
  await expect(page.getByText('Imported image 1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'TikTok scheduling unavailable' })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('imported-mixed.png'), fullPage: true });
  await page.locator('.tiktok-video-preview').screenshot({
    path: testInfo.outputPath('imported-mixed-detail.png'),
  });
  await page.getByRole('button', { name: 'Remove from post' }).first().click();
  await expect(page.getByText('Imported image 1')).toHaveCount(0);
  await expect(page.getByText('Imported MP4 video', { exact: true })).toBeVisible();
  await expect(page.locator('video[aria-label="Preview Imported MP4 video"]')).toBeVisible();
  const hooksBeforePreviewError = await page.evaluate(
    () => (window as typeof window & { __relayErrorHooks: unknown[] }).__relayErrorHooks.length,
  );
  await page.locator('video[aria-label="Preview Imported MP4 video"]').evaluate((element) => {
    element.dispatchEvent(new Event('error'));
    element.dispatchEvent(new Event('error'));
  });
  await expect(page.getByText('This video preview or metadata could not be loaded')).toBeVisible();
  const hooksAfterPreviewError = await page.evaluate(
    () => (window as typeof window & { __relayErrorHooks: unknown[] }).__relayErrorHooks,
  );
  expect(hooksAfterPreviewError).toHaveLength(hooksBeforePreviewError + 1);
  expect(hooksAfterPreviewError.at(-1)).toEqual({
    type: 'user_error_shown',
    properties: { area: 'composer', category: 'validation' },
  });
  await expect
    .poll(() =>
      page
        .locator('video[aria-label="Preview Imported MP4 video"]')
        .evaluate((element) => (element as HTMLVideoElement).readyState),
    )
    .toBeGreaterThanOrEqual(1);
  await expect(page.getByText('1 seconds', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('imported-video.png'), fullPage: true });
  await page.locator('.tiktok-video-preview').screenshot({
    path: testInfo.outputPath('imported-video-detail.png'),
  });
  await page.getByRole('button', { name: 'Remove from post' }).click();
  await expect(page.getByText('No video selected', { exact: true })).toBeVisible();
  await page.locator('#composer-media-upload').setInputFiles({
    name: 'replacement.mp4',
    mimeType: 'video/mp4',
    buffer: video,
  });
  await expect(page.locator('video[aria-label="Preview replacement.mp4"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('imported-replaced.png'), fullPage: true });

  media = [
    {
      id: IMPORTED_IMAGE,
      mimeType: 'image/jpeg',
      byteSize: 1000,
      durationMs: null,
      ready: true,
      previewUrl: `/api/workflow/media/${IMPORTED_IMAGE}`,
    },
  ];
  await page.reload();
  await page.getByRole('checkbox', { name: /TikTok One/ }).check();
  await expect(page.getByText('not an MP4 video')).toBeVisible();
  await expect(page.getByText('Imported MP4 video', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('imported-image-only.png'), fullPage: true });
  await page.locator('.tiktok-video-preview').screenshot({
    path: testInfo.outputPath('imported-image-only-detail.png'),
  });

  media = [
    {
      id: IMPORTED_VIDEO,
      mimeType: 'video/mp4',
      byteSize: null,
      durationMs: null,
      ready: true,
      previewUrl: null,
    },
  ];
  await page.reload();
  await page.getByRole('checkbox', { name: /TikTok One/ }).check();
  await expect(page.getByText('no verified duration or preview')).toBeVisible();
  await expect(page.getByText('Imported MP4 video', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove from post' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('imported-metadata-missing.png'),
    fullPage: true,
  });
  await page.locator('.tiktok-video-preview').screenshot({
    path: testInfo.outputPath('imported-metadata-missing-detail.png'),
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
});

test('TikTok uses one explicit account, fresh options, and an unavailable final action', async ({
  page,
}, testInfo) => {
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registration = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Relay Owner',
      email: `tiktok-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `TikTok ${suffix}`,
    },
  });
  expect(registration.ok()).toBe(true);
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
              id: TIKTOK_ONE,
              provider: 'tiktok',
              displayName: 'TikTok One',
              status: 'active',
              availability: 'active',
            },
            {
              id: TIKTOK_TWO,
              provider: 'tiktok',
              displayName: 'TikTok Two',
              status: 'active',
              availability: 'active',
            },
            {
              id: X_ACCOUNT,
              provider: 'x',
              displayName: 'X Account',
              status: 'active',
              availability: 'active',
            },
          ],
        },
        error: null,
      }),
    }),
  );
  let changedOptions = false;
  await page.route('**/api/provider-accounts/*/tiktok-capabilities', (route) => {
    const accountId = route.request().url().includes(TIKTOK_ONE) ? TIKTOK_ONE : TIKTOK_TWO;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: '00000000-0000-4000-8000-000000000399',
          accountId,
          nickname: accountId === TIKTOK_ONE ? 'Fresh Creator One' : 'Fresh Creator Two',
          privacyOptions: changedOptions
            ? ['SELF_ONLY']
            : ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
          commentDisabled: false,
          duetDisabled: true,
          stitchDisabled: true,
          maxVideoDurationSeconds: 60,
          fetchedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        },
        error: null,
      }),
    });
  });
  await page.goto(`/w/${workspace.data.slug}/queue`);
  await page.getByRole('button', { name: 'Create post' }).last().click();
  const first = page.getByRole('checkbox', { name: /TikTok One/ });
  const second = page.getByRole('checkbox', { name: /TikTok Two/ });
  const x = page.getByRole('checkbox', { name: /X Account/ });
  await expect(first).not.toBeChecked();
  await expect(second).not.toBeChecked();
  await first.check();
  await expect(x).not.toBeChecked();
  await expect(page.getByText('Posting as')).toContainText('Fresh Creator One');
  await expect(page.getByRole('button', { name: 'Visibility' })).toContainText('Choose visibility');
  await expect(page.getByLabel('Duet')).toBeDisabled();
  await expect(page.getByLabel('Stitch')).toBeDisabled();
  await expect(page.getByRole('radio', { name: 'Yes' })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'No' })).not.toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Commercial content', exact: true }),
  ).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'TikTok scheduling unavailable' })).toBeDisabled();
  await page.getByRole('button', { name: 'Visibility' }).click();
  await page.getByRole('option', { name: 'Everyone' }).click();
  await page.locator('#composer-media-upload').setInputFiles({
    name: 'draft.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('fixture video bytes'),
  });
  await expect(page.locator('video[aria-label="Preview draft.mp4"]')).toBeVisible();
  await page.getByRole('textbox', { name: 'Caption' }).fill('A deliberate caption');
  await page.getByRole('radio', { name: 'Yes' }).check();
  await expect(page.getByText('20 / 2200 characters')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Commercial content', exact: true }).check();
  await expect(page.getByText('Choose Your brand, Branded content, or both.')).toBeVisible();
  await page.getByRole('checkbox', { name: /Your brand/ }).check();
  await expect(page.getByText('Promotional content')).toBeVisible();
  await page.getByRole('checkbox', { name: /Branded content ·/ }).check();
  await expect(page.getByText('Paid partnership')).toBeVisible();
  await page.getByRole('button', { name: 'Visibility' }).click();
  await page.getByRole('option', { name: 'Only me' }).click();
  await expect(page.getByText('Branded content cannot use private visibility.')).toBeVisible();
  await page.getByRole('button', { name: 'Visibility' }).click();
  await page.getByRole('option', { name: 'Friends' }).click();
  await expect(page.getByText('Branded content cannot use private visibility.')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Music Usage Confirmation' })).toHaveAttribute(
    'href',
    'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en',
  );
  await expect(page.getByRole('link', { name: 'Branded Content Policy' })).toHaveAttribute(
    'href',
    'https://www.tiktok.com/legal/page/global/bc-policy/en',
  );
  await page.getByRole('checkbox', { name: /Music Usage Confirmation/ }).check();
  await page.getByRole('checkbox', { name: /Branded Content Policy/ }).check();
  await expect(page.getByRole('region', { name: 'Review TikTok publication' })).toContainText(
    'Your brand + Branded content',
  );
  await page.screenshot({
    path: testInfo.outputPath('tiktok-composer-populated.png'),
    fullPage: true,
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page
      .locator('.composer-sheet')
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe('none');
  changedOptions = true;
  await page.getByRole('button', { name: 'Refresh TikTok options' }).click();
  await expect(page.getByText('This visibility is no longer available')).toBeVisible();
  await expect(
    page.getByText(
      'Branded content is unavailable while this account offers only private visibility.',
    ),
  ).toBeVisible();
  await second.check();
  await expect(first).not.toBeChecked();
  await expect(page.getByText('Posting as')).toContainText('Fresh Creator Two');
  await expect(page.getByText('This visibility is no longer available')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('tiktok-composer-switched.png'),
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test('TikTok creator failure and expiry remain visible and recoverable without posting', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const scope = window as typeof window & { __relayErrorHooks: unknown[] };
    scope.__relayErrorHooks = [];
    window.addEventListener('publish-relay-analytics', (event) => {
      const detail = (event as CustomEvent<{ type: string }>).detail;
      if (detail.type === 'user_error_shown') scope.__relayErrorHooks.push(detail);
    });
  });
  const suffix = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const registration = await page.request.post('/api/auth/register', {
    data: {
      displayName: 'Relay Owner',
      email: `tiktok-recovery-${suffix}@example.test`,
      password: 'long-password-123!',
      workspaceName: `TikTok recovery ${suffix}`,
    },
  });
  expect(registration.ok()).toBe(true);
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
              id: TIKTOK_ONE,
              provider: 'tiktok',
              displayName: 'TikTok One',
              status: 'active',
              availability: 'active',
            },
          ],
        },
        error: null,
      }),
    }),
  );
  let failed = true;
  await page.route('**/api/provider-accounts/*/tiktok-capabilities', (route) =>
    route.fulfill(
      failed
        ? {
            status: 502,
            contentType: 'application/json',
            body: '{"data":null,"error":"TikTok options could not be refreshed"}',
          }
        : {
            contentType: 'application/json',
            body: JSON.stringify({
              data: {
                id: '00000000-0000-4000-8000-000000000399',
                accountId: TIKTOK_ONE,
                nickname: 'Fresh Creator',
                privacyOptions: ['SELF_ONLY'],
                commentDisabled: true,
                duetDisabled: true,
                stitchDisabled: true,
                maxVideoDurationSeconds: 60,
                fetchedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
                expiresAt: new Date(Date.now() - 60_000).toISOString(),
              },
              error: null,
            }),
          },
    ),
  );
  await page.goto(`/w/${workspace.data.slug}/queue`);
  await page.getByRole('button', { name: 'Create post' }).last().click();
  const account = page.getByRole('checkbox', { name: /TikTok One/ });
  await expect(account).not.toBeChecked();
  await account.focus();
  await page.keyboard.press('Space');
  await expect(account).toBeChecked();
  await expect(page.getByRole('alert')).toContainText('TikTok options could not be refreshed');
  const hooksAfterFailure = await page.evaluate(
    () => (window as typeof window & { __relayErrorHooks: unknown[] }).__relayErrorHooks,
  );
  expect(hooksAfterFailure).toContainEqual({
    type: 'user_error_shown',
    properties: { area: 'composer', category: 'provider' },
  });
  await expect(page.getByRole('button', { name: 'TikTok scheduling unavailable' })).toBeDisabled();
  failed = false;
  await page.getByRole('button', { name: 'Refresh TikTok options' }).click();
  await expect(page.getByText('TikTok options expired')).toBeVisible();
  const hooksAfterExpiry = await page.evaluate(
    () => (window as typeof window & { __relayErrorHooks: unknown[] }).__relayErrorHooks,
  );
  expect(hooksAfterExpiry).toHaveLength(hooksAfterFailure.length + 2);
  expect(hooksAfterExpiry.at(-1)).toEqual({
    type: 'user_error_shown',
    properties: { area: 'composer', category: 'provider' },
  });
  await expect(page.getByRole('button', { name: 'Visibility' })).toContainText('Choose visibility');
  await expect(page.getByRole('button', { name: 'TikTok scheduling unavailable' })).toBeDisabled();
});
