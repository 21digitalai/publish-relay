import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  findFanvueDmCheckpointForAction,
  reserveFanvueDmCheckpointWithDisposition,
  settleFanvueDmCheckpoint,
} from './fanvue-dm-checkpoint.repository.js';

export interface FanvueCheckpointCommand {
  workspaceId: string;
  accountId: string;
  fanUuid: string;
  clientActionId: string;
  checkpoint?:
    | {
    kind: 'welcome' | 'silent_followup' | 'free_gift' | 'paid_offer';
    ordinal: number;
    groupId?: string | null;
    providerMediaUuid?: string | null;
      }
    | undefined;
}

type Settlement =
  | { state: 'confirmed'; providerMessageUuid: string }
  | { state: 'unknown' }
  | { state: 'cancelled' };

export class FanvueCheckpointMediaConflictError extends Error {
  constructor() {
    super('Fanvue checkpoint media conflicts with the canonical message');
  }
}

export async function reserveFanvueActionCheckpoint(
  database: NodePgDatabase,
  command: FanvueCheckpointCommand,
  resolvedMediaUuids?: string[],
) {
  const checkpoint =
    command.checkpoint ?? (await findFanvueDmCheckpointForAction(database, command));
  if (!checkpoint) return { kind: 'none' as const };
  const mediaUuid = checkpoint.providerMediaUuid;
  if (mediaUuid && resolvedMediaUuids && !resolvedMediaUuids.includes(mediaUuid))
    throw new FanvueCheckpointMediaConflictError();
  if (!command.checkpoint) return { kind: 'existing' as const };
  const reservation = await reserveFanvueDmCheckpointWithDisposition(database, {
    workspaceId: command.workspaceId,
    accountId: command.accountId,
    fanUuid: command.fanUuid,
    clientActionId: command.clientActionId,
    groupId: checkpoint.groupId ?? null,
    providerMediaUuid: mediaUuid ?? null,
    kind: checkpoint.kind as NonNullable<FanvueCheckpointCommand['checkpoint']>['kind'],
    ordinal: checkpoint.ordinal,
  });
  return { kind: reservation.kind };
}

export async function settleFanvueActionCheckpoint(
  database: NodePgDatabase,
  command: FanvueCheckpointCommand,
  settlement: Settlement,
) {
  const checkpoint =
    command.checkpoint ?? (await findFanvueDmCheckpointForAction(database, command));
  if (!checkpoint) return;
  await settleFanvueDmCheckpoint(database, {
    workspaceId: command.workspaceId,
    accountId: command.accountId,
    fanUuid: command.fanUuid,
    clientActionId: command.clientActionId,
    kind: checkpoint.kind as NonNullable<FanvueCheckpointCommand['checkpoint']>['kind'],
    ordinal: checkpoint.ordinal,
    ...settlement,
  });
}
