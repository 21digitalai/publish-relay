import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import {
  InstagramUnifiedEligibilityError,
  createInstagramUnifiedSendService,
} from './instagram-unified-send.service.js';
import {
  claimDueInstagramUnifiedIntent,
  finishClaimedInstagramUnifiedIntent,
  renewClaimedInstagramUnifiedIntent,
} from './instagram-unified-pending.repository.js';
import type { InstagramUnifiedReadClient } from './instagram-unified-read-client.js';

interface Runtime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  client: InstagramUnifiedReadClient;
  workerId: string;
  leaseMs: number;
}
type Intent = NonNullable<Awaited<ReturnType<typeof claimDueInstagramUnifiedIntent>>>;

export async function dispatchDueInstagramUnifiedIntent(runtime: Runtime, now = new Date()) {
  const intent = await claimDueInstagramUnifiedIntent(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
  });
  if (!intent) return { confirmed: 0, failed: 0, unknown: 0, expired: 0 };
  const renewal = setInterval(
    () =>
      void renewClaimedInstagramUnifiedIntent(runtime.database, {
        workspaceId: intent.workspaceId,
        id: intent.id,
        leaseOwner: intent.leaseOwner ?? '',
        leaseMs: runtime.leaseMs,
      }).catch(() => undefined),
    Math.max(100, Math.floor(runtime.leaseMs / 3)),
  );
  renewal.unref();
  let state: 'confirmed' | 'failed' | 'unknown' | 'expired' = 'failed';
  try {
    const send = createInstagramUnifiedSendService(runtime);
    if (intent.kind !== 'comment_reply' && intent.kind !== 'dm_reply')
      throw new InstagramUnifiedEligibilityError();
    if (
      intent.actorType !== 'user' &&
      intent.actorType !== 'api_key' &&
      intent.actorType !== 'delegated'
    )
      throw new InstagramUnifiedEligibilityError();
    const outcome = await send.send({
      workspaceId: intent.workspaceId,
      accountId: intent.accountId,
      clientActionId: intent.clientActionId,
      kind: intent.kind,
      targetId: intent.targetId,
      parentId: intent.parentId,
      ...(intent.recipientId ? { recipientId: intent.recipientId } : {}),
      text: intent.text,
      targetFingerprint: intent.targetFingerprint,
      actor: {
        type: intent.actorType === 'api_key' ? 'api-key' : intent.actorType,
        id: intent.actorId,
      },
    });
    state = outcome.state;
  } catch (error) {
    state = error instanceof InstagramUnifiedEligibilityError ? 'expired' : 'unknown';
  } finally {
    clearInterval(renewal);
  }
  await finishClaimedInstagramUnifiedIntent(runtime.database, {
    workspaceId: intent.workspaceId,
    id: intent.id,
    leaseOwner: intent.leaseOwner ?? '',
    state,
  });
  return {
    confirmed: Number(state === 'confirmed'),
    failed: Number(state === 'failed'),
    unknown: Number(state === 'unknown'),
    expired: Number(state === 'expired'),
  };
}

export type InstagramUnifiedPendingIntent = Intent;
