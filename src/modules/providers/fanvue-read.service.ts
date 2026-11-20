import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { providerAccounts, providerConnections } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import {
  FanvueReconnectionRequiredError,
  getFreshFanvueToken,
} from './fanvue-credential.service.js';
import { FanvueRequestError, type FanvueHttpClient } from './fanvue-http-client.js';
import type { FanvueReadClient } from './fanvue-read-client.js';

export type FanvueReadModule = 'chat' | 'post' | 'media' | 'audience';

const REQUIRED_SCOPES: Record<FanvueReadModule, string> = {
  chat: 'read:chat',
  post: 'read:post',
  media: 'read:media',
  audience: 'read:fan',
};

export class FanvueReadUnavailableError extends Error {
  constructor(
    public readonly reason: 'account_not_found' | 'scope_missing' | 'reconnect_required',
  ) {
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

  async listFollowers(input: {
    workspaceId: string;
    accountId: string;
    page?: number;
    size?: number;
  }) {
    const token = await this.accessToken(input, 'audience');
    return this.readClient.listFollowers(token, input);
  }

  async listSubscribers(input: {
    workspaceId: string;
    accountId: string;
    page?: number;
    size?: number;
    cursor?: string;
  }) {
    const token = await this.accessToken(input, 'audience');
    return this.readClient.listSubscribers(token, input);
  }

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

  /** A returned counterpart message proves this selected creator already has the fan chat. */
  async getExistingChatForMessage(input: {
    workspaceId: string;
    accountId: string;
    fanUuid: string;
  }) {
    return this.getExistingChat(input, ['write:chat']);
  }

  private async getExistingChat(
    input: { workspaceId: string; accountId: string; fanUuid: string },
    additionalScopes: string[],
  ) {
    const fanUuid = z.uuid().parse(input.fanUuid);
    const token = await this.accessToken(input, 'chat', additionalScopes);
    const messages = await this.readClient.listMessages(token, fanUuid, { size: 1 });
    const first = messages.data[0];
    if (!first || (first.sender.uuid !== fanUuid && first.recipient.uuid !== fanUuid))
      throw new FanvueReadUnavailableError('account_not_found');
    const counterpart = first.sender.uuid === fanUuid ? first.sender : first.recipient;
    const handle = counterpart.handle?.trim();
    return {
      accessToken: token,
      targetLabel: handle && /^[A-Za-z0-9._-]{1,159}$/.test(handle) ? `@${handle}` : null,
    };
  }

  /** Chat creation is scoped to the selected creator and its optional send grant. */
  async getChatCreateToken(input: { workspaceId: string; accountId: string }) {
    return this.accessToken(input, 'chat', ['write:chat']);
  }

  async listMedia(input: { workspaceId: string; accountId: string; page?: number; size?: number }) {
    const token = await this.accessToken(input, 'media');
    return this.readClient.listMedia(token, input);
  }

  async getMediaStatus(input: { workspaceId: string; accountId: string; mediaUuid: string }) {
    const token = await this.accessToken(input, 'media');
    return this.readClient.getMediaStatus(token, input.mediaUuid);
  }

  async getMediaPurchaseFact(input: {
    workspaceId: string;
    accountId: string;
    mediaUuid: string;
    fanUuid: string;
  }) {
    try {
      const { accessToken } = await this.getExistingChat(input, ['read:media']);
      const media = await this.readClient.getMediaPurchaseFact(
        accessToken,
        input.mediaUuid,
        input.fanUuid,
      );
      return { state: 'known' as const, purchasedByFan: media.purchasedByFan };
    } catch (error) {
      if (error instanceof FanvueRequestError)
        return { state: 'unknown' as const, purchasedByFan: null };
      throw error;
    }
  }

  async getMediaThumbnail(input: { workspaceId: string; accountId: string; mediaUuid: string }) {
    const token = await this.accessToken(input, 'media');
    const media = await this.readClient.getMediaThumbnail(token, input.mediaUuid);
    const thumbnail = media.variants.find((variant) => variant.variantType === 'thumbnail');
    return { status: media.status, url: thumbnail?.url ?? null };
  }

  async listVaultFolders(input: {
    workspaceId: string;
    accountId: string;
    page?: number;
    size?: number;
    mediaName?: string;
  }) {
    const token = await this.accessToken(input, 'media');
    return this.readClient.listVaultFolders(token, input);
  }

  async listVaultFolderMedia(input: {
    workspaceId: string;
    accountId: string;
    folderName: string;
    page?: number;
    size?: number;
  }) {
    const token = await this.accessToken(input, 'media');
    return this.readClient.listVaultFolderMedia(token, input.folderName, input);
  }

  /** DM media staging requires the selected creator's chat and media grants together. */
  async getDmMediaUploadToken(input: { workspaceId: string; accountId: string }) {
    return this.accessToken(input, 'media', ['write:media', 'read:chat', 'write:chat']);
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

  async getMediaPublicationCoverage(input: {
    workspaceId: string;
    accountId: string;
    mediaUuid: string;
    maxPages?: number;
  }) {
    const mediaUuid = z.uuid().parse(input.mediaUuid);
    const maxPages = z.number().int().min(1).max(100).default(20).parse(input.maxPages);
    const token = await this.accessToken(input, 'post');
    const scannedAt = new Date();
    const postUuids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 1; page <= maxPages; page += 1) {
      let response: Awaited<ReturnType<FanvueReadClient['listPosts']>>;
      try {
        response = await this.readClient.listPosts(token, {
          ...(cursor ? { cursor } : {}),
          size: 50,
        });
      } catch (error) {
        if (!(error instanceof FanvueRequestError)) throw error;
        return publicationCoverage('unknown', scannedAt, page - 1, postUuids.size, false, 'scan_failed');
      }
      for (const post of response.data) {
        postUuids.add(post.uuid);
        if (post.publishedAt && post.mediaUuids.includes(mediaUuid))
          return {
            ...publicationCoverage('posted', scannedAt, page, postUuids.size, false, null),
            matchingPostUuid: post.uuid,
            publishedAt: new Date(post.publishedAt),
          };
      }
      if (!response.nextCursor)
        return publicationCoverage('unposted', scannedAt, page, postUuids.size, true, null);
      if (cursors.has(response.nextCursor))
        return publicationCoverage('unknown', scannedAt, page, postUuids.size, false, 'cursor_loop');
      cursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    return publicationCoverage('unknown', scannedAt, maxPages, postUuids.size, false, 'scan_capped');
  }

  /** Internal command preflight: Fanvue GET only returns a post owned by this token's creator. */
  async getOwnedPostForComment(input: {
    workspaceId: string;
    accountId: string;
    postUuid: string;
  }) {
    const token = await this.accessToken(input, 'post', ['write:post']);
    const post = await this.readClient.getPost(token, input.postUuid);
    return { post, accessToken: token };
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
    additionalScopes: readonly string[] = [],
  ): Promise<string> {
    const requiredScopes = [REQUIRED_SCOPES[module], ...additionalScopes];
    const [account] = await withTenantTransaction(this.database, input, (transaction) =>
      transaction
        .select({
          creatorId: providerAccounts.remoteAccountId,
          connectionId: providerConnections.id,
          scopes: providerConnections.scopes,
          connectionStatus: providerConnections.status,
          lastErrorCode: providerConnections.lastErrorCode,
        })
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
            isNull(providerAccounts.disconnectedAt),
            eq(providerConnections.provider, 'fanvue'),
            isNull(providerConnections.revokedAt),
          ),
        )
        .limit(1),
    );
    if (!account) throw new FanvueReadUnavailableError('account_not_found');
    if (
      account.connectionStatus !== 'active' &&
      !(
        account.connectionStatus === 'reauth_required' &&
        account.lastErrorCode === 'refresh_pending'
      )
    )
      throw new FanvueReadUnavailableError('reconnect_required');
    const storedScopes = z.array(z.string()).safeParse(account.scopes);
    if (
      !storedScopes.success ||
      !requiredScopes.every((scope) => storedScopes.data.includes(scope))
    )
      throw new FanvueReadUnavailableError('scope_missing');
    let token;
    try {
      token = await getFreshFanvueToken(this.database, this.keys, this.oauthClient, {
        workspaceId: input.workspaceId,
        creatorId: account.creatorId,
      });
    } catch (error) {
      if (error instanceof FanvueReconnectionRequiredError)
        throw new FanvueReadUnavailableError('reconnect_required');
      throw error;
    }
    const grantedScopes = token.scope.split(/\s+/);
    if (!requiredScopes.every((scope) => grantedScopes.includes(scope)))
      throw new FanvueReadUnavailableError('scope_missing');
    const [stillConnected] = await withTenantTransaction(this.database, input, (transaction) =>
      transaction
        .select({ id: providerAccounts.id })
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
            eq(providerAccounts.connectionId, account.connectionId),
            eq(providerAccounts.availability, 'active'),
            isNull(providerAccounts.disconnectedAt),
            eq(providerConnections.status, 'active'),
            isNull(providerConnections.revokedAt),
          ),
        )
        .limit(1),
    );
    if (!stillConnected) throw new FanvueReadUnavailableError('account_not_found');
    return token.access_token;
  }
}

function publicationCoverage(
  state: 'posted' | 'unposted' | 'unknown',
  scannedAt: Date,
  pagesScanned: number,
  uniquePostsScanned: number,
  complete: boolean,
  incompleteReason: 'scan_failed' | 'cursor_loop' | 'scan_capped' | null,
) {
  return { state, scannedAt, pagesScanned, uniquePostsScanned, complete, incompleteReason };
}
