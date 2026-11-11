import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  facebookPageDmActions,
  facebookPageDmFailureCircuit,
  facebookPageDmMemory,
  facebookPageDmNoGo,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { lockPageDmAccount } from './facebook-dm-no-go.repository.js';
import { recordPageDmActiveDay } from './facebook-dm-active-days.repository.js';

const MAX_CONSECUTIVE_DEFINITE_FAILURES = 3;

export interface FacebookDmActionKey {
  workspaceId: string;
  accountId: string;
  clientActionId: string;
  conversationId: string;
  text: string;
  receiverLabel?: string | null;
  requestFingerprint: string;
  finalExit?: boolean;
  bioLinkMention?: boolean;
  actor: { type: 'user' | 'api-key' | 'delegated'; id: string };
}

export type FacebookDmOutcome =
  | { state: 'confirmed'; messageId: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' };

export interface FacebookDmFailureEvidence {
  code?: number | undefined;
  subcode?: number | undefined;
  traceId?: string | undefined;
  isTransient?: boolean | undefined;
}

function boundedDiagnosticNumber(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && value !== undefined && value >= 0 && value <= 2_147_483_647
    ? value
    : null;
}

export type FacebookDmReservation =
  | { kind: 'new'; id: string }
  | { kind: 'conflict' }
  | { kind: 'existing'; outcome: FacebookDmOutcome };

function replay(
  row: {
    accountId: string;
    conversationId: string;
    requestFingerprint: string;
    state: string;
    providerMessageId: string | null;
    failureStatus: number | null;
  },
  input: FacebookDmActionKey,
): FacebookDmReservation {
  if (
    row.accountId !== input.accountId ||
    row.conversationId !== input.conversationId ||
    row.requestFingerprint !== input.requestFingerprint
  )
    return { kind: 'conflict' };
  if (row.state === 'confirmed' && row.providerMessageId)
    return { kind: 'existing', outcome: { state: 'confirmed', messageId: row.providerMessageId } };
  if (row.state === 'failed' && row.failureStatus)
    return { kind: 'existing', outcome: { state: 'failed', failureStatus: row.failureStatus } };
  return { kind: 'existing', outcome: { state: 'unknown' } };
}

async function readAction(transaction: NodePgDatabase, input: FacebookDmActionKey) {
  const [row] = await transaction
    .select({
      accountId: facebookPageDmActions.accountId,
      conversationId: facebookPageDmActions.conversationId,
      requestFingerprint: facebookPageDmActions.requestFingerprint,
      state: facebookPageDmActions.state,
      providerMessageId: facebookPageDmActions.providerMessageId,
      failureStatus: facebookPageDmActions.failureStatus,
    })
    .from(facebookPageDmActions)
    .where(
      and(
        eq(facebookPageDmActions.workspaceId, input.workspaceId),
        eq(facebookPageDmActions.clientActionId, input.clientActionId),
      ),
    )
    .limit(1);
  return row ? replay(row, input) : null;
}

export async function findFacebookDmAction(database: NodePgDatabase, input: FacebookDmActionKey) {
  return withTenantTransaction(database, input, (transaction) => readAction(transaction, input));
}

/** The reservation commits before the provider call; a crash leaves an unknown, never a retry. */
export async function reserveFacebookDmAction(
  database: NodePgDatabase,
  input: FacebookDmActionKey,
): Promise<FacebookDmReservation> {
  return withTenantTransaction(database, input, async (transaction) => {
    const [inserted] = await transaction
      .insert(facebookPageDmActions)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        clientActionId: input.clientActionId,
        conversationId: input.conversationId,
        textBody: input.text,
        receiverLabel: input.receiverLabel?.trim().slice(0, 200) ?? null,
        requestFingerprint: input.requestFingerprint,
        finalExit: input.finalExit ?? false,
        bioLinkMention: input.bioLinkMention ?? false,
        actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type,
        actorId: input.actor.id,
      })
      .onConflictDoNothing()
      .returning({ id: facebookPageDmActions.id });
    if (inserted) return { kind: 'new', id: inserted.id };
    const existing = await readAction(transaction, input);
    if (!existing) throw new Error('Facebook DM reservation disappeared');
    return existing;
  });
}

export type FacebookDmSettlement = FacebookDmActionKey & {
  reservationId: string;
  outcome: FacebookDmOutcome;
  failureEvidence?: FacebookDmFailureEvidence;
  inboundReceipt?: { messageId: string; at: Date };
  confirmedAt?: Date;
};

export async function settleFacebookDmAction(
  database: NodePgDatabase,
  input: FacebookDmSettlement,
): Promise<void> {
  await withTenantTransaction(database, input, async (transaction) => {
    await lockPageDmAccount(transaction, input);
    await settleFacebookDmActionInTransaction(transaction, input);
  });
}

/** Caller must hold the selected Page lock until this settlement commits. */
export async function settleFacebookDmActionInTransaction(
  transaction: NodePgDatabase,
  input: FacebookDmSettlement,
): Promise<void> {
  const [updated] = await transaction
    .update(facebookPageDmActions)
    .set({
      state: input.outcome.state,
      providerMessageId: input.outcome.state === 'confirmed' ? input.outcome.messageId : null,
      failureStatus: input.outcome.state === 'failed' ? input.outcome.failureStatus : null,
      failureCode:
        input.outcome.state === 'failed'
          ? boundedDiagnosticNumber(input.failureEvidence?.code)
          : null,
      failureSubcode:
        input.outcome.state === 'failed'
          ? boundedDiagnosticNumber(input.failureEvidence?.subcode)
          : null,
      failureTraceId:
        input.outcome.state === 'failed' &&
        typeof input.failureEvidence?.traceId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(input.failureEvidence.traceId)
          ? input.failureEvidence.traceId
          : null,
      failureTransient:
        input.outcome.state === 'failed' && typeof input.failureEvidence?.isTransient === 'boolean'
          ? input.failureEvidence.isTransient
          : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(facebookPageDmActions.workspaceId, input.workspaceId),
        eq(facebookPageDmActions.id, input.reservationId),
        eq(facebookPageDmActions.state, 'reserved'),
        eq(facebookPageDmActions.finalExit, input.finalExit ?? false),
        eq(facebookPageDmActions.bioLinkMention, input.bioLinkMention ?? false),
      ),
    )
    .returning({ id: facebookPageDmActions.id });
  if (!updated) throw new Error('Facebook DM settlement lost reservation');
  if (input.outcome.state === 'confirmed' && input.inboundReceipt) {
    await recordPageDmActiveDay(transaction, {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      inboundMessageId: input.inboundReceipt.messageId,
      inboundAt: input.inboundReceipt.at,
      outboundActionId: input.clientActionId,
      outboundMessageId: input.outcome.messageId,
      outboundAt: input.confirmedAt ?? new Date(),
    });
  }
  if (input.bioLinkMention && input.outcome.state === 'confirmed') {
    const at = input.confirmedAt ?? new Date();
    await transaction
      .insert(facebookPageDmMemory)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        bioLinkMentionAt: at,
        bioLinkActionId: input.clientActionId,
        bioLinkMessageId: input.outcome.messageId,
        lastOutboundReceiptRef: input.outcome.messageId,
      })
      .onConflictDoUpdate({
        target: [
          facebookPageDmMemory.workspaceId,
          facebookPageDmMemory.accountId,
          facebookPageDmMemory.conversationId,
        ],
        set: {
          bioLinkMentionAt: at,
          bioLinkActionId: input.clientActionId,
          bioLinkMessageId: input.outcome.messageId,
          lastOutboundReceiptRef: input.outcome.messageId,
          updatedAt: new Date(),
        },
      });
  }
  if (input.finalExit && input.outcome.state === 'confirmed') {
    await transaction
      .insert(facebookPageDmNoGo)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        displayName: input.receiverLabel?.trim().slice(0, 200) ?? null,
        reason: 'campaign_final',
        finalActionId: input.clientActionId,
        finalMessageId: input.outcome.messageId,
      })
      .onConflictDoNothing();
    await transaction
      .insert(facebookPageDmMemory)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        terminal: true,
        finalExitAt: new Date(),
        finalActionId: input.clientActionId,
        finalMessageId: input.outcome.messageId,
        lastOutboundReceiptRef: input.outcome.messageId,
      })
      .onConflictDoUpdate({
        target: [
          facebookPageDmMemory.workspaceId,
          facebookPageDmMemory.accountId,
          facebookPageDmMemory.conversationId,
        ],
        set: {
          terminal: true,
          finalExitAt: new Date(),
          finalActionId: input.clientActionId,
          finalMessageId: input.outcome.messageId,
          lastOutboundReceiptRef: input.outcome.messageId,
          updatedAt: new Date(),
        },
      });
  }
  if (
    input.outcome.state === 'confirmed' ||
    (input.outcome.state === 'failed' && input.failureEvidence)
  ) {
    await transaction
      .insert(facebookPageDmFailureCircuit)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
      })
      .onConflictDoNothing();
    const [circuit] = await transaction
      .select({
        consecutiveFailures: facebookPageDmFailureCircuit.consecutiveFailures,
        haltedAt: facebookPageDmFailureCircuit.haltedAt,
      })
      .from(facebookPageDmFailureCircuit)
      .where(
        and(
          eq(facebookPageDmFailureCircuit.workspaceId, input.workspaceId),
          eq(facebookPageDmFailureCircuit.accountId, input.accountId),
        ),
      )
      .limit(1)
      .for('update');
    if (!circuit) throw new Error('Facebook DM circuit state unavailable');
    const failures = input.outcome.state === 'confirmed' ? 0 : circuit.consecutiveFailures + 1;
    await transaction
      .update(facebookPageDmFailureCircuit)
      .set({
        consecutiveFailures: circuit.haltedAt ? circuit.consecutiveFailures : failures,
        haltedAt:
          circuit.haltedAt ?? (failures >= MAX_CONSECUTIVE_DEFINITE_FAILURES ? new Date() : null),
        lastActionId: input.clientActionId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(facebookPageDmFailureCircuit.workspaceId, input.workspaceId),
          eq(facebookPageDmFailureCircuit.accountId, input.accountId),
        ),
      );
  }
  await transaction.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type,
    actorId: input.actor.id,
    action: 'facebook_page.dm_send',
    targetType: 'provider_account',
    targetId: input.accountId,
    requestId: input.clientActionId,
    metadata: { outcome: input.outcome.state, conversationId: input.conversationId },
  });
}

export async function readPageDmFailureCircuit(
  database: NodePgDatabase,
  input: Pick<FacebookDmActionKey, 'workspaceId' | 'accountId'>,
) {
  return withTenantTransaction(database, input, async (tx) => {
    await lockPageDmAccount(tx, input);
    const [row] = await tx
      .select({
        consecutiveFailures: facebookPageDmFailureCircuit.consecutiveFailures,
        haltedAt: facebookPageDmFailureCircuit.haltedAt,
        updatedAt: facebookPageDmFailureCircuit.updatedAt,
      })
      .from(facebookPageDmFailureCircuit)
      .where(
        and(
          eq(facebookPageDmFailureCircuit.workspaceId, input.workspaceId),
          eq(facebookPageDmFailureCircuit.accountId, input.accountId),
        ),
      )
      .limit(1);
    return row ?? { consecutiveFailures: 0, haltedAt: null, updatedAt: null };
  });
}

export async function clearPageDmFailureCircuit(
  database: NodePgDatabase,
  input: Pick<FacebookDmActionKey, 'workspaceId' | 'accountId'> & {
    actorId: string;
    requestId: string;
  },
) {
  return withTenantTransaction(database, input, async (tx) => {
    await lockPageDmAccount(tx, input);
    const [row] = await tx
      .update(facebookPageDmFailureCircuit)
      .set({
        consecutiveFailures: 0,
        haltedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(facebookPageDmFailureCircuit.workspaceId, input.workspaceId),
          eq(facebookPageDmFailureCircuit.accountId, input.accountId),
        ),
      )
      .returning({ haltedAt: facebookPageDmFailureCircuit.haltedAt });
    await tx.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: 'user',
      actorId: input.actorId,
      action: 'facebook_page.dm_failure_circuit_clear',
      targetType: 'provider_account',
      targetId: input.accountId,
      requestId: input.requestId,
      metadata: { hadCircuit: Boolean(row) },
    });
    return { consecutiveFailures: 0, haltedAt: null };
  });
}
