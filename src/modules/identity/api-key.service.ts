import { timingSafeEqual } from 'node:crypto';

import {
  createApiKeyMaterial,
  hashApiKeySecret,
  isApiKeyUsable,
  parseApiKeyCapabilities,
  parseApiKeyToken,
  hasApiKeyCapability,
  type ApiKeyCapability,
} from './api-key.js';

export interface ApiKeyPrincipal {
  id: string;
  workspaceId: string;
  createdByUserId: string;
  workspaceLabel: string;
  prefix: string;
  capabilities: ApiKeyCapability[];
  expiresAt: Date | null;
}

export interface ApiKeyRecord extends ApiKeyPrincipal {
  secretHash: string;
  revokedAt: Date | null;
}

export interface ApiKeySummary extends ApiKeyPrincipal {
  label: string;
  createdByDisplayName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  capabilityVersion: number;
}

export type CapabilityUpdateResult = 'updated' | 'not_found' | 'conflict';

export interface ApiKeyStore {
  create(input: {
    workspaceId: string;
    createdByUserId: string;
    label: string;
    prefix: string;
    secretHash: string;
    capabilities: ApiKeyCapability[];
    expiresAt: Date | null;
    requestId: string;
  }): Promise<ApiKeyPrincipal>;
  findByPrefix(workspaceId: string, prefix: string): Promise<ApiKeyRecord | null>;
  list(workspaceId: string, userId: string): Promise<ApiKeySummary[]>;
  markUsed(workspaceId: string, keyId: string, usedAt: Date): Promise<void>;
  recordCapabilityDenied(
    principal: ApiKeyPrincipal,
    capability: ApiKeyCapability,
    requestId: string,
  ): Promise<void>;
  revoke(input: {
    workspaceId: string;
    keyId: string;
    revokedByUserId: string;
    revokedAt: Date;
    requestId: string;
  }): Promise<boolean>;
  updateCapabilities(input: {
    workspaceId: string;
    keyId: string;
    updatedByUserId: string;
    expectedVersion: number;
    capabilities: ApiKeyCapability[];
    requestId: string;
  }): Promise<CapabilityUpdateResult>;
}

export class ApiKeyAuthorizationError extends Error {
  public readonly statusCode = 403;
  public readonly code = 'missing_capability';
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
    requestId: string;
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
      requestId: input.requestId,
    });
    return { key, token: material.token };
  }

  public async authenticate(
    expectedWorkspaceId: string,
    token: string,
    now = new Date(),
  ): Promise<ApiKeyPrincipal | null> {
    const parsed = parseApiKeyToken(token);
    if (!parsed) return null;
    const record = await this.store.findByPrefix(expectedWorkspaceId, parsed.prefix);
    if (!record || !isApiKeyUsable(record, now)) return null;
    if (!hashesMatch(hashApiKeySecret(parsed.secret), record.secretHash)) return null;
    await this.store.markUsed(record.workspaceId, record.id, now);
    const { secretHash, revokedAt, ...principal } = record;
    void secretHash;
    void revokedAt;
    return principal;
  }

  public list(workspaceId: string, userId: string): Promise<ApiKeySummary[]> {
    return this.store.list(workspaceId, userId);
  }

  public updateCapabilities(input: {
    workspaceId: string;
    keyId: string;
    updatedByUserId: string;
    expectedVersion: number;
    capabilities: readonly string[];
    requestId: string;
  }): Promise<CapabilityUpdateResult> {
    if (input.capabilities.length === 0) throw new Error('At least one capability is required');
    return this.store.updateCapabilities({
      ...input,
      capabilities: parseApiKeyCapabilities(input.capabilities),
    });
  }

  public async requireCapability(
    principal: ApiKeyPrincipal,
    capability: ApiKeyCapability,
    requestId: string,
  ): Promise<void> {
    if (hasApiKeyCapability(new Set(principal.capabilities), capability)) return;
    await this.store.recordCapabilityDenied(principal, capability, requestId);
    throw new ApiKeyAuthorizationError(`API key is missing capability ${capability}`);
  }

  public async revoke(input: {
    workspaceId: string;
    keyId: string;
    revokedByUserId: string;
    requestId: string;
    revokedAt?: Date;
  }): Promise<boolean> {
    return this.store.revoke({ ...input, revokedAt: input.revokedAt ?? new Date() });
  }
}
