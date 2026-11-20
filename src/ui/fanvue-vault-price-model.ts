export interface FanvueVaultFolder {
  id: string;
  name: string;
}

export interface FanvueVaultMedia {
  id: string;
  name: string;
  folderId: string | null;
  folderName: string | null;
  priceUsd: string | null;
  previewSrc: string | null;
}

export interface FanvueVaultMediaPage {
  items: FanvueVaultMedia[];
  nextCursor: string | null;
}

export interface FanvueVaultPriceAdapter {
  loadFolders(accountId: string, signal: AbortSignal): Promise<FanvueVaultFolder[]>;
  loadMedia(input: {
    accountId: string;
    folderId: string | null;
    cursor: string | null;
    signal: AbortSignal;
  }): Promise<FanvueVaultMediaPage>;
  savePrice(input: {
    accountId: string;
    mediaId: string;
    priceUsd: string | null;
  }): Promise<{ priceUsd: string | null }>;
}

export function normalizeFanvueUsdPrice(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new Error('Enter a positive USD amount with no more than two decimal places.');
  }
  return Number(trimmed).toFixed(2);
}

export function mergeFanvueMedia(
  current: FanvueVaultMedia[],
  incoming: FanvueVaultMedia[],
): FanvueVaultMedia[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}
