import { createHash } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { loadInstagramUnifiedToken } from './instagram-unified-read.service.js';
import type { InstagramUnifiedReadClient } from './instagram-unified-read-client.js';
import { InstagramUnifiedReadError } from './instagram-unified-read-client.js';
import { reserveInstagramUnifiedAction, settleInstagramUnifiedAction, type InstagramUnifiedActionInput, type InstagramUnifiedActionOutcome } from './instagram-unified-action.repository.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';

const inputSchema = z.strictObject({ workspaceId: z.uuid(), accountId: z.uuid(), clientActionId: z.uuid(), kind: z.enum(['comment_reply', 'dm_reply']), targetId: z.string().min(1).max(256), parentId: z.string().min(1).max(256), recipientId: z.string().min(1).max(256).optional(), text: z.string().trim().min(1).max(2000), actor: z.strictObject({ type: z.enum(['user', 'api-key', 'delegated']), id: z.uuid() }) });

export class InstagramUnifiedActionConflictError extends Error {}
export class InstagramUnifiedEligibilityError extends Error {}

export function createInstagramUnifiedSendService(runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: InstagramUnifiedReadClient }) {
  return { async send(input: z.input<typeof inputSchema>): Promise<InstagramUnifiedActionOutcome> {
    const command = inputSchema.parse(input);
    const token = await loadInstagramUnifiedToken(runtime, command);
    const permission = await runtime.client.verifyPermissions(token.accessToken);
    if (permission.instagram_manage_comments !== 'granted') throw new InstagramUnifiedEligibilityError();
    if (command.kind === 'dm_reply') {
      const messaging = await runtime.client.verifyMessagingPermission(token.accessToken);
      if (messaging !== 'granted' || !command.recipientId) throw new InstagramUnifiedEligibilityError();
      const messages = await runtime.client.listMessages({ accountId: token.remoteAccountId, conversationId: command.parentId, accessToken: token.accessToken, limit: 100 });
      const latest = messages.messages.filter((message) => message.senderId && message.senderId !== token.remoteAccountId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      if (!latest || Date.parse(latest.createdAt) < Date.now() - 24 * 60 * 60 * 1000 || latest.senderId !== command.recipientId) throw new InstagramUnifiedEligibilityError();
    } else {
      await runtime.client.listComments({ accountId: token.remoteAccountId, mediaId: command.parentId, accessToken: token.accessToken, limit: 1 });
    }
    const action: InstagramUnifiedActionInput = { workspaceId: command.workspaceId, accountId: command.accountId, clientActionId: command.clientActionId, kind: command.kind, targetId: command.targetId, parentId: command.parentId, ...(command.recipientId ? { recipientId: command.recipientId } : {}), text: command.text, actor: command.actor, requestFingerprint: createHash('sha256').update(JSON.stringify({ accountId: command.accountId, kind: command.kind, targetId: command.targetId, parentId: command.parentId, recipientId: command.recipientId ?? null, text: command.text })).digest('hex') };
    const reservation = await reserveInstagramUnifiedAction(runtime.database, action);
    if (reservation.kind === 'conflict') throw new InstagramUnifiedActionConflictError();
    if (reservation.kind === 'existing') return reservation.outcome;
    let outcome: InstagramUnifiedActionOutcome;
    try {
      const receipt = command.kind === 'comment_reply' ? await runtime.client.replyToComment({ commentId: command.targetId, text: command.text, accessToken: token.accessToken }) : await runtime.client.sendConversationMessage({ conversationId: command.parentId, recipientId: command.recipientId ?? '', text: command.text, accessToken: token.accessToken });
      outcome = { state: 'confirmed', receipt };
    } catch (error) {
      if (error instanceof InstagramUnifiedReadError && error.status >= 400 && error.status < 500 && error.status !== 429) outcome = { state: 'failed', failureStatus: error.status };
      else outcome = { state: 'unknown' };
    }
    await settleInstagramUnifiedAction(runtime.database, { ...action, reservationId: reservation.id, outcome });
    return outcome;
  } };
}
