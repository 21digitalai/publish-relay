import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { fanvueActionIntents } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { ActionPolicyDeniedError } from '../policy/action-policy.js';
import type { FanvueCommentService } from './fanvue-comment.service.js';
import {
  claimDueFanvueComment,
  finishClaimedFanvueComment,
  renewClaimedFanvueComment,
} from './fanvue-comment-pending.repository.js';
import { hasCurrentFanvueAuthority } from './fanvue-dm-pending.worker.js';
import { FanvueReadUnavailableError } from './fanvue-read.service.js';

interface Runtime {
  database: NodePgDatabase;
  comments: Pick<FanvueCommentService, 'send'>;
  workerId: string;
  leaseMs: number;
}

type Intent = NonNullable<Awaited<ReturnType<typeof claimDueFanvueComment>>>;
type State = 'confirmed' | 'failed' | 'unknown' | 'pending';

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
      action.targetUuid !== intent.postUuid ||
      action.actionKind !== 'comment' ||
      action.text !== intent.text
    )
      return 'unknown';
    return action.state === 'confirmed' || action.state === 'failed' ? action.state : 'unknown';
  });
}

async function dispatchOne(runtime: Runtime, intent: Intent): Promise<State> {
  const prior = await existingActionState(runtime.database, intent);
  if (prior) return prior;
  if (intent.actorType === 'system') return 'failed';
  if (!(await hasCurrentFanvueAuthority(runtime.database, intent, 'fanvue:comments:send')))
    return 'failed';
  try {
    const result = await runtime.comments.send({
      workspaceId: intent.workspaceId,
      accountId: intent.accountId,
      postUuid: intent.postUuid,
      clientActionId: intent.clientActionId,
      text: intent.text,
      actor: {
        type: intent.actorType === 'api_key' ? 'api-key' : intent.actorType,
        id: intent.actorId,
      },
    });
    return result.state;
  } catch (error) {
    const action = await existingActionState(runtime.database, intent);
    if (action) return action;
    if (error instanceof FanvueReadUnavailableError || error instanceof ActionPolicyDeniedError)
      return 'failed';
    return 'pending';
  }
}

export async function dispatchDueFanvueComments(runtime: Runtime, now = new Date()) {
  const intent = await claimDueFanvueComment(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
  });
  if (!intent) return null;
  const renewal = setInterval(
    () => {
      void renewClaimedFanvueComment(runtime.database, {
        workspaceId: intent.workspaceId,
        id: intent.id,
        leaseOwner: intent.leaseOwner ?? '',
        leaseMs: runtime.leaseMs,
      }).catch(() => {
        // The durable action reservation is still the duplicate-send fence.
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
  const settled = await finishClaimedFanvueComment(runtime.database, {
    workspaceId: intent.workspaceId,
    id: intent.id,
    leaseOwner: intent.leaseOwner ?? '',
    state,
  });
  return { state, settled };
}
