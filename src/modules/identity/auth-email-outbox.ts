import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { authEmailOutbox } from '../../database/schema.js';
import {
  decryptCredential,
  encryptCredential,
  type EncryptedCredential,
  type MasterKeyProvider,
} from '../credentials/envelope.js';
import type { EmailDelivery } from './magic-link.service.js';

interface AuthEmailPayload {
  challengeId?: string;
  recipient: string;
  url: string;
  correlationId: string;
}

export class AuthEmailOutboxDelivery implements EmailDelivery {
  constructor(
    private readonly database: NodePgDatabase,
    private readonly keys: MasterKeyProvider,
  ) {}

  async sendMagicLink(input: AuthEmailPayload): Promise<{ messageId: string; queued: true }> {
    if (!input.challengeId) throw new Error('Auth email challenge identity is required');
    const encrypted = await encryptCredential(Buffer.from(JSON.stringify(input)), this.keys);
    const [queued] = await this.database
      .insert(authEmailOutbox)
      .values({ challengeId: input.challengeId, ...encrypted })
      .returning({ id: authEmailOutbox.id });
    if (!queued) throw new Error('Auth email was not queued');
    return { messageId: queued.id, queued: true };
  }
}

interface ClaimedEmail extends EncryptedCredential, Record<string, unknown> {
  id: string;
  challengeId: string;
  attemptCount: number;
}

async function claimEmails(
  database: NodePgDatabase,
  input: { workerId: string; now: Date; leaseMs: number; limit: number },
): Promise<ClaimedEmail[]> {
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  const result = await database.execute<ClaimedEmail>(sql`
    WITH candidates AS (
      SELECT id FROM auth_email_outbox
      WHERE sent_at IS NULL AND available_at <= ${input.now}
        AND (lease_expires_at IS NULL OR lease_expires_at <= ${input.now})
      ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT ${input.limit}
    )
    UPDATE auth_email_outbox AS item
    SET lease_owner = ${input.workerId}, lease_expires_at = ${leaseExpiresAt},
        attempt_count = attempt_count + 1, updated_at = ${input.now}
    FROM candidates WHERE item.id = candidates.id
    RETURNING item.id, item.challenge_id AS "challengeId", item.key_version AS "keyVersion",
      item.wrapped_key AS "wrappedKey", item.wrapped_key_nonce AS "wrappedKeyNonce",
      item.wrapped_key_tag AS "wrappedKeyTag", item.ciphertext, item.nonce, item.tag,
      item.attempt_count AS "attemptCount"
  `);
  return result.rows;
}

function parsePayload(plaintext: Buffer): AuthEmailPayload {
  const value = JSON.parse(plaintext.toString('utf8')) as Partial<AuthEmailPayload>;
  if (!value.recipient || !value.url || !value.correlationId)
    throw new Error('Auth email outbox payload is invalid');
  return value as AuthEmailPayload;
}

export async function dispatchAuthEmailOutbox(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  delivery: EmailDelivery,
  input: { workerId: string; now?: Date; leaseMs: number; limit?: number },
): Promise<{ sent: number; failed: number }> {
  const now = input.now ?? new Date();
  const claimed = await claimEmails(database, { ...input, now, limit: input.limit ?? 20 });
  let sent = 0;
  let failed = 0;
  for (const item of claimed) {
    try {
      const plaintext = await decryptCredential(item, keys);
      const payload = parsePayload(plaintext);
      plaintext.fill(0);
      const result = await delivery.sendMagicLink(payload);
      await database.transaction(async (transaction) => {
        await transaction.execute(sql`
          UPDATE auth_email_outbox SET sent_at = ${now}, lease_owner = NULL,
            lease_expires_at = NULL, last_error_code = NULL, updated_at = ${now}
          WHERE id = ${item.id} AND lease_owner = ${input.workerId}
        `);
        await transaction.execute(sql`
          UPDATE login_challenges SET delivery_state = 'sent',
            provider_message_id = ${result.messageId}, updated_at = ${now}
          WHERE id = ${item.challengeId}
        `);
      });
      sent += 1;
    } catch {
      const delaySeconds = Math.min(300, 2 ** Math.min(item.attemptCount, 8));
      await database.transaction(async (transaction) => {
        await transaction.execute(sql`
          UPDATE auth_email_outbox
          SET available_at = ${new Date(now.getTime() + delaySeconds * 1000)},
            lease_owner = NULL, lease_expires_at = NULL, last_error_code = 'delivery_failed',
            updated_at = ${now} WHERE id = ${item.id} AND lease_owner = ${input.workerId}
        `);
        await transaction.execute(sql`
          UPDATE login_challenges SET delivery_state = 'failed', updated_at = ${now}
          WHERE id = ${item.challengeId}
        `);
      });
      failed += 1;
    }
  }
  return { sent, failed };
}
