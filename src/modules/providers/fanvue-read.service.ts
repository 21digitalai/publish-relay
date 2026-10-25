import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerAccounts, providerConnections } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { getFreshFanvueToken } from './fanvue-credential.service.js';
import type { FanvueHttpClient } from './fanvue-http-client.js';
import type { FanvueReadClient } from './fanvue-read-client.js';

export type FanvueReadModule = 'chat' | 'post' | 'media';

const REQUIRED_SCOPES: Record<FanvueReadModule, string> = {
  chat: 'read:chat',
  post: 'read:post',
  media: 'read:media',
};

export class FanvueReadUnavailableError extends Error {
  constructor(public readonly reason: 'account_not_found' | 'scope_missing') {
    super(
      reason === 'account_not_found'
        ? 'Fanvue account is unavailable'
        : 'Fanvue read permission requires reconnection',
    );
  }
}

export class FanvueReadService {
  constructor(
    private readonly database: NodePgDatabase,
    private readonly keys: MasterKeyProvider,
    private readonly oauthClient: FanvueHttpClient,
    private readonly readClient: FanvueReadClient,
  ) {}

  async listChats(input: {
    workspaceId: string;
    accountId: string;
    page?: number;
    size?: number;
    unreadOnly?: boolean;
  }) {
    const token = await this.accessToken(input, 'chat');
    return this.readClient.listChats(token, input);
  }

  async listMessages(input: {
    workspaceId: string;
    accountId: string;
    fanUuid: string;
    page?: number;
    size?: number;
  }) {
    const token = await this.accessToken(input, 'chat');
    return this.readClient.listMessages(token, input.fanUuid, input);
  }

  async listMedia(input: { workspaceId: string; accountId: string; page?: number; size?: number }) {
    const token = await this.accessToken(input, 'media');
    return this.readClient.listMedia(token, input);
  }

  async getMediaStatus(input: { workspaceId: string; accountId: string; mediaUuid: string }) {
    const token = await this.accessToken(input, 'media');
    return this.readClient.getMediaStatus(token, input.mediaUuid);
  }

  async listPosts(input: {
    workspaceId: string;
    accountId: string;
    cursor?: string;
    size?: number;
  }) {
    const token = await this.accessToken(input, 'post');
    return this.readClient.listPosts(token, input);
  }

  async getPost(input: { workspaceId: string; accountId: string; postUuid: string }) {
    const token = await this.accessToken(input, 'post');
    return this.readClient.getPost(token, input.postUuid);
  }

  async listComments(input: {
    workspaceId: string;
    accountId: string;
    postUuid: string;
    cursor?: string;
    size?: number;
  }) {
    const token = await this.accessToken(input, 'post');
    return this.readClient.listComments(token, input.postUuid, input);
  }

  private async accessToken(
    input: { workspaceId: string; accountId: string },
    module: FanvueReadModule,
  ): Promise<string> {
    const [account] = await withTenantTransaction(this.database, input, (transaction) =>
      transaction
        .select({ creatorId: providerAccounts.remoteAccountId, scopes: providerConnections.scopes })
        .from(providerAccounts)
        .innerJoin(
          providerConnections,
          and(
            eq(providerConnections.workspaceId, providerAccounts.workspaceId),
            eq(providerConnections.id, providerAccounts.connectionId),
          ),
        )
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
            eq(providerAccounts.destinationProvider, 'fanvue'),
            eq(providerAccounts.availability, 'active'),
            isNull(providerAccounts.disconnectedAt),
            eq(providerConnections.provider, 'fanvue'),
            eq(providerConnections.status, 'active'),
            isNull(providerConnections.revokedAt),
          ),
        )
        .limit(1),
    );
    if (!account) throw new FanvueReadUnavailableError('account_not_found');
    if (!Array.isArray(account.scopes) || !account.scopes.includes(REQUIRED_SCOPES[module]))
      throw new FanvueReadUnavailableError('scope_missing');
    const token = await getFreshFanvueToken(this.database, this.keys, this.oauthClient, {
      workspaceId: input.workspaceId,
      creatorId: account.creatorId,
    });
    if (!token.scope.split(/\s+/).includes(REQUIRED_SCOPES[module]))
      throw new FanvueReadUnavailableError('scope_missing');
    return token.access_token;
  }
}
