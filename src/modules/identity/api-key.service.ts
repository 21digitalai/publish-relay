import { timingSafeEqual } from 'node:crypto';

import {
  createApiKeyMaterial,
  hashApiKeySecret,
  isApiKeyUsable,
  parseApiKeyCapabilities,
  parseApiKeyToken,
  type ApiKeyCapability,
} from './api-key.js';

export interface ApiKeyPrincipal {
  id: string;
  workspaceId: string;
  workspaceLabel: string;
  prefix: string;
  capabilities: ApiKeyCapability[];
  expiresAt: Date | null;
}

export interface ApiKeyRecord extends ApiKeyPrincipal {
  secretHash: string;
  revokedAt: Date | null;
}

export interface ApiKeyStore {
  create(input: {
    workspaceId: string;
    createdByUserId: string;
    label: string;
    prefix: string;
    secretHash: string;
    capabilities: ApiKeyCapability[];
    expiresAt: Date | null;
  }): Promise<ApiKeyPrincipal>;
  findByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  markUsed(workspaceId: string, keyId: string, usedAt: Date): Promise<void>;
}

function hashesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export class ApiKeyService {
  public constructor(private readonly store: ApiKeyStore) {}

  public async create(input: {
    workspaceId: string;
    createdByUserId: string;
    label: string;
    capabilities: readonly string[];
    expiresAt?: Date | null;
  }): Promise<{ key: ApiKeyPrincipal; token: string }> {
    const label = input.label.trim();
    if (!label) throw new Error('API key label is required');
    const material = createApiKeyMaterial();
    const key = await this.store.create({
      workspaceId: input.workspaceId,
      createdByUserId: input.createdByUserId,
      label,
      prefix: material.prefix,
      secretHash: material.secretHash,
      capabilities: parseApiKeyCapabilities(input.capabilities),
      expiresAt: input.expiresAt ?? null,
    });
    return { key, token: material.token };
  }

  public async authenticate(token: string, now = new Date()): Promise<ApiKeyPrincipal | null> {
    const parsed = parseApiKeyToken(token);
    if (!parsed) return null;
    const record = await this.store.findByPrefix(parsed.prefix);
    if (!record || !isApiKeyUsable(record, now)) return null;
    if (!hashesMatch(hashApiKeySecret(parsed.secret), record.secretHash)) return null;
    await this.store.markUsed(record.workspaceId, record.id, now);
    const { secretHash, revokedAt, ...principal } = record;
    void secretHash;
    void revokedAt;
    return principal;
  }
}
