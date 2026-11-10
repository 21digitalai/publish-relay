import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { memberships } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import {
  allowAllActionPolicy,
  ActionPolicyDeniedError,
  type ActionPolicy,
} from '../policy/action-policy.js';
import { authorizePageEngagement } from './facebook-page-engagement.service.js';
import { findFacebookCommentAction } from './facebook-comment-action.repository.js';
import {
  claimDuePageComment,
  finishClaimedPageComment,
  renewClaimedPageComment,
} from './facebook-comment-pending.repository.js';
import {
  sendAccountPageCommentReply,
  FacebookCommentActionConflictError,
} from './facebook-comment-send.service.js';
import { readScheduledCommentTarget } from './facebook-comments-read.service.js';
import { FacebookRequestError, type FacebookHttpClient } from './facebook-http-client.js';
import { PageReadUnavailableError } from './facebook-page-read-context.service.js';

interface Runtime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  client: FacebookHttpClient;
  workerId: string;
  leaseMs: number;
  policy?: ActionPolicy;
}

type Intent = NonNullable<Awaited<ReturnType<typeof claimDuePageComment>>>;
type DispatchState = 'confirmed' | 'failed' | 'unknown' | 'pending';

async function hasCurrentAuthority(database: NodePgDatabase, intent: Intent) {
  if (intent.actorType === 'user') {
    return withTenantTransaction(database, intent, async (tx) => {
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
    });
  }
  if (intent.actorType !== 'api_key' && intent.actorType !== 'delegated') return false;
  return authorizePageEngagement(database, {
    workspaceId: intent.workspaceId,
    accountId: intent.accountId,
    principal: {
      kind: intent.actorType === 'api_key' ? 'api-key' : 'delegated',
      actorId: intent.actorId,
      workspaceId: intent.workspaceId,
    },
    capability: 'comments:send',
  });
}

async function existingActionState(database: NodePgDatabase, intent: Intent) {
  const expected = createHash('sha256')
    .update(
      JSON.stringify({
        accountId: intent.accountId,
        postId: intent.postId,
        commentId: intent.commentId,
        text: intent.text,
      }),
    )
    .digest('hex');
  const action = await findFacebookCommentAction(database, {
    workspaceId: intent.workspaceId,
    accountId: intent.accountId,
    postId: intent.postId,
    commentId: intent.commentId,
    clientActionId: intent.clientActionId,
    text: intent.text,
    requestFingerprint: expected,
    actor: {
      type:
        intent.actorType === 'api_key'
          ? 'api-key'
          : intent.actorType === 'delegated'
            ? 'delegated'
            : 'user',
      id: intent.actorId,
    },
  });
  if (!action) return undefined;
  if (action.kind === 'conflict') return 'unknown';
  if (action.kind === 'existing') return action.outcome.state;
  return 'unknown';
}

async function dispatchOne(runtime: Runtime, intent: Intent): Promise<DispatchState> {
  try {
    const prior = await existingActionState(runtime.database, intent);
    if (prior) return prior;
    if (!(await hasCurrentAuthority(runtime.database, intent))) return 'failed';
    const target = await readScheduledCommentTarget(runtime, intent);
    if (
      target.hasPageReply ||
      target.text !== intent.targetText ||
      target.createdAt !== intent.targetCreatedAt ||
      target.threadFingerprint !== intent.threadFingerprint
    )
      return 'failed';
    const outcome = await sendAccountPageCommentReply(
      { ...runtime, policy: runtime.policy ?? allowAllActionPolicy },
      {
        workspaceId: intent.workspaceId,
        accountId: intent.accountId,
        postId: intent.postId,
        commentId: intent.commentId,
        clientActionId: intent.clientActionId,
        text: intent.text,
        actor: {
          type:
            intent.actorType === 'api_key'
              ? 'api-key'
              : intent.actorType === 'delegated'
                ? 'delegated'
                : 'user',
          id: intent.actorId,
        },
      },
    );
    return outcome.state;
  } catch (error) {
    if (await existingActionState(runtime.database, intent)) return 'unknown';
    if (
      error instanceof PageReadUnavailableError ||
      error instanceof ActionPolicyDeniedError ||
      error instanceof FacebookCommentActionConflictError ||
      (error instanceof FacebookRequestError &&
        !['transient', 'rate_limit'].includes(error.evidence.kind))
    )
      return 'failed';
    return 'pending';
  }
}

export async function dispatchDuePageComments(runtime: Runtime, now = new Date()) {
  const intent = await claimDuePageComment(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
  });
  if (!intent) return { confirmed: 0, failed: 0, unknown: 0, pending: 0 };
  const renewal = setInterval(
    () => {
      void renewClaimedPageComment(runtime.database, {
        workspaceId: intent.workspaceId,
        id: intent.id,
        leaseOwner: intent.leaseOwner ?? '',
        leaseMs: runtime.leaseMs,
      }).catch(() => {
        // A stale lease cannot settle; the action ledger still prevents duplicate provider I/O.
      });
    },
    Math.max(100, Math.floor(runtime.leaseMs / 3)),
  );
  renewal.unref();
  let state: DispatchState;
  try {
    state = await dispatchOne(runtime, intent);
  } finally {
    clearInterval(renewal);
  }
  await finishClaimedPageComment(runtime.database, {
    workspaceId: intent.workspaceId,
    id: intent.id,
    leaseOwner: intent.leaseOwner ?? '',
    state,
  });
  return {
    confirmed: Number(state === 'confirmed'),
    failed: Number(state === 'failed'),
    unknown: Number(state === 'unknown'),
    pending: Number(state === 'pending'),
  };
}
