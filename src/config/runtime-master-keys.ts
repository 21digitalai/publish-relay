import type { MasterKeyProvider } from '../modules/credentials/envelope.js';

const KEY_BYTES = 32;

export class RuntimeMasterKeyProvider implements MasterKeyProvider {
  public constructor(
    private readonly activeVersion: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    if (!activeVersion) throw new Error('An active master-key version is required');
    this.readKey(activeVersion);
  }

  public currentVersion(): string {
    return this.activeVersion;
  }

  public getKey(version: string): Promise<Buffer> {
    return Promise.resolve(this.readKey(version));
  }

  private readKey(version: string): Buffer {
    if (!/^[A-Za-z0-9_]+$/.test(version)) throw new Error('Master-key version is invalid');
    const encoded = this.environment[`PUBLISH_RELAY_MASTER_KEY_${version}`];
    if (!encoded) throw new Error(`Master key version ${version} is unavailable`);
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== encoded)
      throw new Error(`Master key version ${version} must contain exactly 32 base64 bytes`);
    return key;
  }
}
