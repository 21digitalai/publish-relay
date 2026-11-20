import { getCsrfToken } from './posting-adapter-connection.js';
import type { FanvueVaultMedia, FanvueVaultPriceAdapter } from './fanvue-vault-price-model.js';

interface Envelope<T> {
  data: T;
}

interface FolderPage {
  data: { name: string }[];
}

interface CatalogPage {
  data: {
    uuid: string;
    name?: string | null;
    manualPriceCents: number | null;
    priceVersion: number | null;
  }[];
  pagination: { hasMore?: boolean };
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Vault request failed (HTTP ${String(response.status)})`);
  return (await response.json()) as T;
}

function mediaName(name: string | null | undefined, uuid: string): string {
  const trimmed = name?.trim();
  if (!trimmed) return uuid;
  return trimmed;
}

export function createFanvueVaultPriceAdapter(): FanvueVaultPriceAdapter {
  const versions = new Map<string, number | null>();
  const folderCache = new Map<string, string[]>();
  const loadFolders = async (accountId: string, signal: AbortSignal) => {
    const response = await fetch(
      `/api/fanvue/accounts/${encodeURIComponent(accountId)}/vault/folders?size=50`,
      { signal },
    );
    const page = await json<Envelope<FolderPage>>(response);
    const names = page.data.data.map((folder) => folder.name);
    folderCache.set(accountId, names);
    return names.map((name) => ({ id: name, name }));
  };
  return {
    loadFolders,
    async loadMedia({ accountId, folderId, cursor, signal }) {
      const pageNumber = cursor === null ? 1 : Number(cursor);
      if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error('Invalid vault cursor');
      const folders = folderId
        ? [folderId]
        : (folderCache.get(accountId) ??
          (await loadFolders(accountId, signal)).map(({ id }) => id));
      const pages = await Promise.all(
        folders.map(async (folder) => {
          const response = await fetch(
            `/api/fanvue/accounts/${encodeURIComponent(accountId)}/vault/catalog/${encodeURIComponent(folder)}?page=${String(pageNumber)}&size=50`,
            { signal },
          );
          return { folder, page: await json<Envelope<CatalogPage>>(response) };
        }),
      );
      const byId = new Map<string, FanvueVaultMedia>();
      for (const { folder, page } of pages) {
        for (const item of page.data.data) {
          versions.set(`${accountId}:${item.uuid}`, item.priceVersion);
          byId.set(item.uuid, {
            id: item.uuid,
            name: mediaName(item.name, item.uuid),
            folderId: folder,
            folderName: folder,
            priceUsd:
              item.manualPriceCents === null ? null : (item.manualPriceCents / 100).toFixed(2),
            previewSrc: `/api/fanvue/accounts/${encodeURIComponent(accountId)}/vault/media/${encodeURIComponent(item.uuid)}/preview`,
          });
        }
      }
      return {
        items: [...byId.values()],
        nextCursor: pages.some(({ page }) => page.data.pagination.hasMore)
          ? String(pageNumber + 1)
          : null,
      };
    },
    async savePrice({ accountId, mediaId, priceUsd, signal }) {
      const response = await fetch(
        `/api/fanvue/accounts/${encodeURIComponent(accountId)}/vault/media/${encodeURIComponent(mediaId)}/price`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
          body: JSON.stringify({
            manualPriceCents: priceUsd === null ? null : Math.round(Number(priceUsd) * 100),
            expectedVersion: versions.get(`${accountId}:${mediaId}`) ?? null,
          }),
          signal,
        },
      );
      const saved =
        await json<Envelope<{ manualPriceCents: number | null; version: number }>>(response);
      versions.set(`${accountId}:${mediaId}`, saved.data.version);
      return {
        priceUsd:
          saved.data.manualPriceCents === null
            ? null
            : (saved.data.manualPriceCents / 100).toFixed(2),
      };
    },
    async refreshPreview({ accountId, mediaId, signal }) {
      const previewSrc = `/api/fanvue/accounts/${encodeURIComponent(accountId)}/vault/media/${encodeURIComponent(mediaId)}/preview?refresh=${String(Date.now())}`;
      const response = await fetch(previewSrc, { method: 'HEAD', signal });
      if (!response.ok) throw new Error('Preview unavailable');
      return { previewSrc };
    },
  };
}
