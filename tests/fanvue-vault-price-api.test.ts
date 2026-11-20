import { afterEach, expect, it, vi } from 'vitest';

import { createFanvueVaultPriceAdapter } from '../src/ui/fanvue-vault-price-api.js';

const accountId = '00000000-0000-4000-8000-000000000001';

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

it('keeps independent opaque cursors when folder membership changes between pages', async () => {
  const requests: string[] = [];
  const fetch = vi.fn((input: string | URL | Request) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'https://relay.example',
    );
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/vault/folders')) {
      if (!url.searchParams.get('cursor'))
        return Promise.resolve(
          envelope({ data: [{ name: 'Followers' }], nextCursor: 'folder-next' }),
        );
      return Promise.resolve(envelope({ data: [{ name: 'Subscribers' }], nextCursor: null }));
    }
    if (url.pathname.endsWith('/vault/catalog/Followers')) {
      if (!url.searchParams.get('cursor'))
        return Promise.resolve(
          envelope({
            data: [
              {
                uuid: '00000000-0000-4000-8000-000000000011',
                name: 'First follower image',
                manualPriceCents: null,
                priceVersion: null,
              },
            ],
            nextCursor: 'followers-next',
            total: 2,
          }),
        );
      return Promise.resolve(
        envelope({
          data: [
            {
              uuid: '00000000-0000-4000-8000-000000000013',
              name: 'Added after first page',
              manualPriceCents: null,
              priceVersion: null,
            },
          ],
          nextCursor: null,
          total: 2,
        }),
      );
    }
    return Promise.resolve(
      envelope({
        data: [
          {
            uuid: '00000000-0000-4000-8000-000000000021',
            name: 'Subscriber image',
            manualPriceCents: 300,
            priceVersion: 1,
          },
        ],
        nextCursor: null,
        total: 1,
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  const adapter = createFanvueVaultPriceAdapter();
  const signal = new AbortController().signal;

  await expect(adapter.loadFolders(accountId, signal)).resolves.toEqual([
    { id: 'Followers', name: 'Followers' },
    { id: 'Subscribers', name: 'Subscribers' },
  ]);
  const first = await adapter.loadMedia({ accountId, folderId: null, cursor: null, signal });
  expect(first.items.map((item) => item.name)).toEqual([
    'First follower image',
    'Subscriber image',
  ]);
  expect(first.nextCursor).toBe('{"Followers":"followers-next","Subscribers":null}');

  const second = await adapter.loadMedia({
    accountId,
    folderId: null,
    cursor: first.nextCursor,
    signal,
  });
  expect(second.items.map((item) => item.name)).toEqual(['Added after first page']);
  expect(second.nextCursor).toBeNull();
  expect(requests.filter((request) => request.includes('/catalog/Subscribers'))).toHaveLength(1);
  expect(requests).toContain(
    `/api/fanvue/accounts/${accountId}/vault/catalog/Followers?size=50&cursor=followers-next`,
  );
});
