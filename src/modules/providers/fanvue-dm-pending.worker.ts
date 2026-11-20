import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  apiKeys,
  delegatedGrants,
  fanvueActionIntents,
  memberships,
  registeredClients,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { ActionPolicyDeniedError } from '../policy/action-policy.js';
import {
  claimDueFanvueDm,
  finishClaimedFanvueDm,
  renewClaimedFanvueDm,
} from './fanvue-dm-pending.repository.js';
import type { FanvueMessageService } from './fanvue-message.service.js';
import { FanvueMessageMediaUnavailableError } from './fanvue-message.service.js';
import { FanvueReadUnavailableError } from './fanvue-read.service.js';

interface Runtime {
  database: NodePgDatabase;
  messages: Pick<FanvueMessageService, 'sendMessage'> &
    Partial<Pick<FanvueMessageService, 'preflightScheduledDispatch'>>;
  workerId: string;
  leaseMs: number;
}

type Intent = NonNullable<Awaited<ReturnType<typeof claimDueFanvueDm>>>;
type State = 'confirmed' | 'failed' | 'unknown' | 'pending' | 'cancelled';

export async function hasCurrentFanvueAuthority(
  database: NodePgDatabase,
  intent: { workspaceId: string; actorType: string; actorId: string },
  capability: 'fanvue:chats:send' | 'fanvue:comments:send',
): Promise<boolean> {
  return withTenantTransaction(database, intent, async (tx) => {
    if (intent.actorType === 'user') {
      const [membership] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, intent.workspaceId),
            eq(memberships.userId, intent.actorId),
          ),
        )
        .limit(1);
      return membership?.role === 'owner' || membership?.role === 'admin';
    }
    if (intent.actorType === 'api_key') {
      const [key] = await tx
        .select({ scopes: apiKeys.capabilities })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.workspaceId, intent.workspaceId),
            eq(apiKeys.id, intent.actorId),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
          ),
        )
        .limit(1);
      return key?.scopes.includes(capability) ?? false;
    }
    if (intent.actorType !== 'delegated') return false;
    const [grant] = await tx
      .select({ scopes: delegatedGrants.scopes, allowed: registeredClients.allowedScopes })
      .from(delegatedGrants)
      .innerJoin(registeredClients, eq(delegatedGrants.clientId, registeredClients.id))
      .where(
        and(
          eq(delegatedGrants.workspaceId, intent.workspaceId),
          eq(delegatedGrants.id, intent.actorId),
          isNull(delegatedGrants.revokedAt),
        ),
      )
      .limit(1);
    return (grant?.scopes.includes(capability) && grant.allowed.includes(capability)) ?? false;
  });
}

async function existingActionState(
  database: NodePgDatabase,
  intent: Intent,
): Promise<State | null> {
  return withTenantTransaction(database, intent, async (tx) => {
    const [action] = await tx
      .select({
        accountId: fanvueActionIntents.accountId,
        targetUuid: fanvueActionIntents.targetUuid,
        actionKind: fanvueActionIntents.actionKind,
        state: fanvueActionIntents.state,
        text: fanvueActionIntents.textBody,
        mediaCount: fanvueActionIntents.mediaCount,
        price: fanvueActionIntents.priceCents,
      })
      .from(fanvueActionIntents)
      .where(
        and(
          eq(fanvueActionIntents.workspaceId, intent.workspaceId),
          eq(fanvueActionIntents.clientActionId, intent.clientActionId),
        ),
      )
      .limit(1);
    if (!action) return null;
    if (
      action.accountId !== intent.accountId ||
      action.targetUuid !== intent.fanUuid ||
      action.actionKind !== 'message' ||
      action.text !== intent.text ||
      action.mediaCount !== intent.mediaIds.length ||
      action.price !== intent.price
    )
      return 'unknown';
    return action.state === 'confirmed' || action.state === 'failed' ? action.state : 'unknown';
  });
}

async function dispatchOne(runtime: Runtime, intent: Intent): Promise<State> {
  const prior = await existingActionState(runtime.database, intent);
  if (prior) return prior;
  if (intent.expectedLatestInboundMessageUuid && runtime.messages.preflightScheduledDispatch) {
    const preflight = await runtime.messages.preflightScheduledDispatch(intent);
    if (preflight === 'cancel') return 'cancelled';
    if (preflight === 'freeze_unknown') return 'unknown';
  }
  if (intent.actorType === 'system') return 'failed';
  if (!(await hasCurrentFanvueAuthority(runtime.database, intent, 'fanvue:chats:send')))
    return 'failed';
  try {
    const result = await runtime.messages.sendMessage(
      {
        workspaceId: intent.workspaceId,
        accountId: intent.accountId,
        fanUuid: intent.fanUuid,
        clientActionId: intent.clientActionId,
        actor: {
          type: intent.actorType === 'api_key' ? 'api-key' : intent.actorType,
          id: intent.actorId,
        },
        ...(intent.text ? { text: intent.text } : {}),
        ...(intent.mediaIds.length ? { mediaIds: intent.mediaIds } : {}),
        ...(intent.mediaPreviewId ? { mediaPreviewId: intent.mediaPreviewId } : {}),
        ...(intent.price !== null ? { price: intent.price } : {}),
      },
      intent.leaseOwner ?? '',
    );
    return result.state;
  } catch (error) {
    // A committed action reservation can have reached Fanvue even if settlement failed.
    const prior = await existingActionState(runtime.database, intent);
    if (prior) return prior;
    if (
      error instanceof FanvueReadUnavailableError ||
      error instanceof FanvueMessageMediaUnavailableError ||
      error instanceof ActionPolicyDeniedError
    )
      return 'failed';
    return 'pending';
  }
}

export async function dispatchDueFanvueDms(runtime: Runtime, now = new Date()) {
  const intent = await claimDueFanvueDm(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
  });
  if (!intent) return null;
  const renewal = setInterval(
    () => {
      void renewClaimedFanvueDm(runtime.database, {
        workspaceId: intent.workspaceId,
        id: intent.id,
        leaseOwner: intent.leaseOwner ?? '',
        leaseMs: runtime.leaseMs,
      }).catch(() => {
        // Action reservation remains the duplicate-send fence if lease renewal fails.
      });
    },
    Math.max(100, Math.floor(runtime.leaseMs / 3)),
  );
  renewal.unref();
  let state: State;
  try {
    state = await dispatchOne(runtime, intent);
  } finally {
    clearInterval(renewal);
  }
  const settled = await finishClaimedFanvueDm(runtime.database, {
    workspaceId: intent.workspaceId,
    id: intent.id,
    leaseOwner: intent.leaseOwner ?? '',
    state,
  });
  return { state, settled };
}
