import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { WorkspaceUsageFacts } from './usage-facts.js';
import { getWorkspaceUsageFactsInTransaction } from './usage-facts.js';

export const ACTION_NAMES = [
  'provider-account.connect',
  'media.ingest',
  'publication.create',
  'publication.revise',
  'publication.reschedule',
  'publication.retry',
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export interface ActionPolicyContext {
  workspaceId: string;
  actor: { type: 'user' | 'api-key'; id: string };
  action: ActionName;
  facts: WorkspaceUsageFacts;
  request: {
    requestId?: string;
    idempotencyKey?: string;
    provider?: string;
    providerAccountIds?: readonly string[];
    mediaBytes?: number;
    scheduledAt?: Date;
  };
  transaction: NodePgDatabase;
}

export type ActionPolicyDecision =
  | { allowed: true; metadata?: Readonly<Record<string, string | number | boolean>> }
  | {
      allowed: false;
      code: string;
      reason: string;
      metadata?: Readonly<Record<string, string | number | boolean>>;
    };

export interface ActionPolicy {
  evaluate(context: ActionPolicyContext): Promise<ActionPolicyDecision>;
}

export class ActionPolicyDeniedError extends Error {
  readonly code: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;

  constructor(decision: Extract<ActionPolicyDecision, { allowed: false }>) {
    super(decision.reason);
    this.name = 'ActionPolicyDeniedError';
    this.code = decision.code;
    this.metadata = decision.metadata ?? {};
  }
}

export const allowAllActionPolicy: ActionPolicy = {
  evaluate() {
    return Promise.resolve({ allowed: true });
  },
};

export async function enforceActionPolicy(
  policy: ActionPolicy,
  context: ActionPolicyContext,
): Promise<void> {
  const decision = await policy.evaluate(context);
  if (!decision.allowed) throw new ActionPolicyDeniedError(decision);
}

export async function enforceWorkspaceAction(
  transaction: NodePgDatabase,
  policy: ActionPolicy,
  input: Omit<ActionPolicyContext, 'facts' | 'transaction'> & {
    requestedProviderAccountIds?: readonly string[];
  },
): Promise<void> {
  const facts = await getWorkspaceUsageFactsInTransaction(transaction, {
    workspaceId: input.workspaceId,
    ...(input.requestedProviderAccountIds
      ? { requestedProviderAccountIds: input.requestedProviderAccountIds }
      : {}),
  });
  await enforceActionPolicy(policy, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: input.action,
    request: input.request,
    facts,
    transaction,
  });
}
