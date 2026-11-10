import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  getFacebookPageGuidance,
  updateFacebookPageGuidance,
} from '../src/modules/credentials/facebook-page-guidance.service.js';

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const connection = '00000000-0000-4000-8000-000000000003';
const page = '00000000-0000-4000-8000-000000000004';
const sibling = '00000000-0000-4000-8000-000000000005';

describe('Facebook Page guidance', () => {
  it('stores three private fields on the selected origin Page and audits lengths only', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`
        CREATE TABLE provider_connections (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, provider text NOT NULL, status text NOT NULL);
        CREATE TABLE provider_accounts (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, connection_id uuid NOT NULL,
          destination_provider text NOT NULL, availability text NOT NULL, disconnected_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
          actor_type text NOT NULL, actor_id uuid, action text NOT NULL, target_type text NOT NULL,
          target_id uuid, request_id text NOT NULL, ip_address text, user_agent text,
          metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
        INSERT INTO provider_connections VALUES ('${connection}', '${owner}', 'meta', 'active');
        INSERT INTO provider_accounts (id, workspace_id, connection_id, destination_provider, availability) VALUES
          ('${page}', '${owner}', '${connection}', 'facebook_page', 'active'),
          ('${sibling}', '${owner}', '${connection}', 'facebook_page', 'active');
      `);
      await pg.exec(
        await readFile(
          new URL('../migrations/0105_facebook_page_guidance.sql', import.meta.url),
          'utf8',
        ),
      );
      const database = drizzle(pg) as unknown as NodePgDatabase;
      const initial = { profile: '', dmGuidance: '', commentGuidance: '' };
      expect(
        await getFacebookPageGuidance(database, { workspaceId: owner, accountId: page }),
      ).toEqual(initial);
      const updated = {
        profile: 'Lives in Sofia',
        dmGuidance: '',
        commentGuidance: 'Playful in public',
      };
      expect(
        await updateFacebookPageGuidance(database, {
          workspaceId: owner,
          accountId: page,
          ...updated,
          actor: { type: 'user', id: owner },
          requestId: 'guidance-1',
        }),
      ).toEqual(updated);
      expect(
        await getFacebookPageGuidance(database, { workspaceId: owner, accountId: page }),
      ).toEqual(updated);
      expect(
        await getFacebookPageGuidance(database, { workspaceId: owner, accountId: sibling }),
      ).toEqual(initial);
      expect(
        await getFacebookPageGuidance(database, { workspaceId: other, accountId: page }),
      ).toBeNull();
      expect(
        await updateFacebookPageGuidance(database, {
          workspaceId: other,
          accountId: page,
          ...initial,
          actor: { type: 'user', id: other },
          requestId: 'wrong-tenant',
        }),
      ).toBeNull();
      const audit = await pg.query<{ metadata: unknown }>('SELECT metadata FROM audit_events');
      expect(audit.rows).toHaveLength(1);
      expect(JSON.stringify(audit.rows)).not.toContain('Sofia');
      expect(JSON.stringify(audit.rows)).not.toContain('Playful');
    } finally {
      await pg.close();
    }
  });
});
