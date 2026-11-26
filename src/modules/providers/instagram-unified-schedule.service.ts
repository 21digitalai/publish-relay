import { createHash } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { loadInstagramUnifiedToken } from './instagram-unified-read.service.js';
import type { InstagramUnifiedReadClient } from './instagram-unified-read-client.js';
import { InstagramUnifiedEligibilityError } from './instagram-unified-send.service.js';
import { getInstagramUnifiedIntent, cancelInstagramUnifiedIntent, scheduleInstagramUnifiedIntent, InstagramUnifiedPendingConflictError } from './instagram-unified-pending.repository.js';

const inputSchema = z.strictObject({
  workspaceId: z.uuid(), accountId: z.uuid(), clientActionId: z.uuid(), kind: z.enum(['comment_reply', 'dm_reply']),
  targetId: z.string().min(1).max(256), parentId: z.string().min(1).max(256), recipientId: z.string().min(1).max(256).optional(),
  text: z.string().trim().min(1).max(2000), dueAt: z.iso.datetime({ offset: true }),
  actor: z.strictObject({ type: z.enum(['user', 'api-key', 'delegated']), id: z.uuid() }),
});

export function createInstagramUnifiedScheduleService(runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: InstagramUnifiedReadClient }) {
  return {
    async schedule(input: z.input<typeof inputSchema>) {
      const command = inputSchema.parse(input);
      const dueAt = new Date(command.dueAt);
      if (dueAt.getTime() <= Date.now()) throw new InstagramUnifiedEligibilityError('Schedule must be in the future');
      const token = await loadInstagramUnifiedToken(runtime, command);
      let targetFingerprint: string;
      if (command.kind === 'comment_reply') {
        const permissions = await runtime.client.verifyPermissions(token.accessToken);
        if (permissions.instagram_manage_comments !== 'granted') throw new InstagramUnifiedEligibilityError();
        await runtime.client.assertCommentOwner({ accountId: token.remoteAccountId, commentId: command.targetId, mediaId: command.parentId, accessToken: token.accessToken });
        targetFingerprint = createHash('sha256').update(JSON.stringify({ kind: command.kind, target: command.targetId, parent: command.parentId })).digest('hex');
      } else {
        if (!command.recipientId) throw new InstagramUnifiedEligibilityError();
        const permission = await runtime.client.verifyMessagingPermission(token.accessToken);
        if (permission !== 'granted') throw new InstagramUnifiedEligibilityError();
        const messages = await runtime.client.listMessages({ accountId: token.remoteAccountId, conversationId: command.parentId, accessToken: token.accessToken, limit: 100 });
        const target = messages.messages.find((message) => message.id === command.targetId);
        const latest = messages.messages.filter((message) => message.senderId && message.senderId !== token.remoteAccountId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        if (!target || !latest || latest.senderId !== command.recipientId || Date.parse(latest.createdAt) < Date.now() - 24 * 60 * 60 * 1000) throw new InstagramUnifiedEligibilityError();
        targetFingerprint = createHash('sha256').update(JSON.stringify({ kind: command.kind, target: target.id, parent: command.parentId, latest: latest.id, latestAt: latest.createdAt })).digest('hex');
      }
      const requestFingerprint = createHash('sha256').update(JSON.stringify({ accountId: command.accountId, kind: command.kind, targetId: command.targetId, parentId: command.parentId, recipientId: command.recipientId ?? null, text: command.text, dueAt: dueAt.toISOString() })).digest('hex');
      const intent = await scheduleInstagramUnifiedIntent(runtime.database, {
        workspaceId: command.workspaceId, accountId: command.accountId, clientActionId: command.clientActionId,
        kind: command.kind, targetId: command.targetId, parentId: command.parentId,
        ...(command.recipientId ? { recipientId: command.recipientId } : {}), text: command.text,
        actor: command.actor, dueAt, requestFingerprint, targetFingerprint,
      });
      return { id: intent.id, status: intent.status, dueAt: intent.dueAt.toISOString() };
    },
    get(input: { workspaceId: string; accountId: string; id: string }) { return getInstagramUnifiedIntent(runtime.database, input); },
    cancel(input: { workspaceId: string; accountId: string; id: string }) { return cancelInstagramUnifiedIntent(runtime.database, input); },
  };
}

export { InstagramUnifiedPendingConflictError };
