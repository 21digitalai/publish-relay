import { hashPassword } from './password.js';
import { createOpaqueToken } from './session.js';

const DEFAULT_REVIEWER_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_REVIEWER_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;

export interface ReviewerAccountStore {
  provision: (input: {
    workspaceId: string;
    operatorUserId: string;
    email: string;
    displayName: string;
    passwordHash: string;
    expiresAt: Date;
    requestId: string;
  }) => Promise<{ userId: string }>;
  revoke: (input: {
    workspaceId: string;
    operatorUserId: string;
    email: string;
    requestId: string;
  }) => Promise<{ userId: string }>;
}

export interface ReviewerProvisionResult {
  userId: string;
  workspaceId: string;
  expiresAt: Date;
  password: string;
}

export class ReviewerAccountService {
  constructor(private readonly store: ReviewerAccountStore) {}

  async provision(input: {
    workspaceId: string;
    operatorUserId: string;
    email: string;
    displayName?: string;
    expiresAt?: Date;
    now?: Date;
    requestId: string;
  }): Promise<ReviewerProvisionResult> {
    const now = input.now ?? new Date();
    const expiresAt = input.expiresAt ?? new Date(now.getTime() + DEFAULT_REVIEWER_LIFETIME_MS);
    if (expiresAt <= now || expiresAt.getTime() - now.getTime() > MAX_REVIEWER_LIFETIME_MS)
      throw new Error('Reviewer expiry must be in the next 90 days');
    const password = createOpaqueToken();
    const displayName = input.displayName?.trim();
    const result = await this.store.provision({
      workspaceId: input.workspaceId,
      operatorUserId: input.operatorUserId,
      email: input.email.trim().toLowerCase(),
      displayName: displayName?.length ? displayName : 'TikTok reviewer',
      passwordHash: await hashPassword(password),
      expiresAt,
      requestId: input.requestId,
    });
    return { ...result, workspaceId: input.workspaceId, expiresAt, password };
  }

  revoke(input: {
    workspaceId: string;
    operatorUserId: string;
    email: string;
    requestId: string;
  }): Promise<{ userId: string }> {
    return this.store.revoke({
      ...input,
      email: input.email.trim().toLowerCase(),
    });
  }
}
