export interface MediaStorage {
  put(input: {
    workspaceId: string;
    mediaId: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<{ storageKey: string }>;
  read(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
}
