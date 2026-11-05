import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { facebookPageDmActions, memberships } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { allowAllActionPolicy, type ActionPolicy } from '../policy/action-policy.js';
import { authorizePageEngagement } from './facebook-page-engagement.service.js';
import type { FacebookHttpClient } from './facebook-http-client.js';
import { claimDuePageDms, finishClaimedPageDm } from './facebook-dm-pending.repository.js';
import { sendAccountPageConversationMessage } from './facebook-messenger-send.service.js';

interface Runtime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  client: FacebookHttpClient;
  workerId: string;
  leaseMs: number;
  policy?: ActionPolicy;
}

type Intent = Awaited<ReturnType<typeof claimDuePageDms>>[number];
type TerminalState = 'confirmed' | 'failed' | 'unknown';

async function hasCurrentAuthority(database: NodePgDatabase, intent: Intent): Promise<boolean> {
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
    capability: 'dms:send',
  });
}

async function existingActionState(database: NodePgDatabase, intent: Intent) {
  return withTenantTransaction(database, intent, async (tx) => {
    const [action] = await tx
      .select({
        state: facebookPageDmActions.state,
        requestFingerprint: facebookPageDmActions.requestFingerprint,
      })
      .from(facebookPageDmActions)
      .where(
        and(
          eq(facebookPageDmActions.workspaceId, intent.workspaceId),
          eq(facebookPageDmActions.clientActionId, intent.clientActionId),
        ),
      )
      .limit(1);
    if (!action) return undefined;
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          accountId: intent.accountId,
          conversationId: intent.conversationId,
          text: intent.text,
        }),
      )
      .digest('hex');
    if (action.requestFingerprint !== expected) return 'unknown';
    return action.state as TerminalState | 'reserved';
  });
}

async function dispatchOne(runtime: Runtime, intent: Intent): Promise<TerminalState> {
  const prior = await existingActionState(runtime.database, intent);
  if (prior) return prior === 'reserved' ? 'unknown' : prior;
  if (!(await hasCurrentAuthority(runtime.database, intent))) return 'failed';
  try {
    const outcome = await sendAccountPageConversationMessage(
      { ...runtime, policy: runtime.policy ?? allowAllActionPolicy },
      {
        workspaceId: intent.workspaceId,
        accountId: intent.accountId,
        conversationId: intent.conversationId,
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
  } catch {
    // A thrown call may have reserved and reached Meta. Only a missing ledger row
    // proves it was pre-send; both outcomes stop this intent without blind retry.
    return (await existingActionState(runtime.database, intent)) ? 'unknown' : 'failed';
  }
}

export async function dispatchDuePageDms(runtime: Runtime, now = new Date()) {
  const claimed = await claimDuePageDms(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 20,
  });
  const counts = { confirmed: 0, failed: 0, unknown: 0 };
  for (const intent of claimed) {
    const state = await dispatchOne(runtime, intent);
    await finishClaimedPageDm(runtime.database, {
      workspaceId: intent.workspaceId,
      id: intent.id,
      workerId: runtime.workerId,
      state,
    });
    counts[state] += 1;
  }
  return counts;
}
import { createHash } from 'node:crypto';
