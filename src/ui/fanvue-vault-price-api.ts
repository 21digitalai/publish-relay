import { getCsrfToken } from './posting-adapter-connection.js';
import type { FanvueVaultMedia, FanvueVaultPriceAdapter } from './fanvue-vault-price-model.js';

interface Envelope<T> {
  data: T;
}

interface FolderPage {
  data: { name: string }[];
  nextCursor: string | null;
}

interface CatalogPage {
  data: {
    uuid: string;
    name?: string | null;
    manualPriceCents: number | null;
    priceVersion: number | null;
  }[];
  nextCursor: string | null;
  total: number | null;
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
    const names: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const query = new URLSearchParams({ size: '50' });
      if (cursor) query.set('cursor', cursor);
      const response = await fetch(
        `/api/fanvue/accounts/${encodeURIComponent(accountId)}/vault/folders?${query}`,
        { signal },
      );
      const page = await json<Envelope<FolderPage>>(response);
      names.push(...page.data.data.map((folder) => folder.name));
      if (!page.data.nextCursor) break;
      if (seen.has(page.data.nextCursor)) throw new Error('Vault folder cursor loop');
      seen.add(page.data.nextCursor);
      cursor = page.data.nextCursor;
    }
    folderCache.set(accountId, names);
    return names.map((name) => ({ id: name, name }));
  };
  return {
    loadFolders,
    async loadMedia({ accountId, folderId, cursor, signal }) {
      const cursorByFolder = cursor
        ? (JSON.parse(cursor) as Record<string, string | null>)
        : Object.create(null);
      const folders = folderId
        ? [folderId]
        : (folderCache.get(accountId) ??
          (await loadFolders(accountId, signal)).map(({ id }) => id));
      const pages = await Promise.all(
        folders
          .filter(
            (folder) =>
              !Object.prototype.hasOwnProperty.call(cursorByFolder, folder) ||
              cursorByFolder[folder] !== null,
          )
          .map(async (folder) => {
          const query = new URLSearchParams({ size: '50' });
          const providerCursor = cursorByFolder[folder];
          if (providerCursor) query.set('cursor', providerCursor);
          const response = await fetch(
            `/api/fanvue/accounts/${encodeURIComponent(accountId)}/vault/catalog/${encodeURIComponent(folder)}?${query}`,
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
      const nextByFolder = Object.fromEntries(
        pages.map(({ folder, page }) => [folder, page.data.nextCursor]),
      );
      return {
        items: [...byId.values()],
        nextCursor: Object.values(nextByFolder).some((value) => value !== null)
          ? JSON.stringify({ ...cursorByFolder, ...nextByFolder })
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
