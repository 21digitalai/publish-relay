export interface MediaStorage {
  put(input: {
    workspaceId: string;
    mediaId: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<{ storageKey: string }>;
  delete(storageKey: string): Promise<void>;
}
