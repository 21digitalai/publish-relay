import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encryptCredential } from '../src/modules/credentials/envelope.js';
import { listAccountPagePosts } from '../src/modules/providers/facebook-comments-read.service.js';
import { listAccountPageConversations } from '../src/modules/providers/facebook-messenger-read.service.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
const siblingId = '00000000-0000-4000-8000-000000000004';
const connectionId = '00000000-0000-4000-8000-000000000005';
const credentialId = '00000000-0000-4000-8000-000000000006';
const keys = { currentVersion: () => 'v1', getKey: () => Promise.resolve(Buffer.alloc(32, 7)) };

let postgres: PGlite;
let database: NodePgDatabase;
let client: {
  listPagePosts: ReturnType<typeof vi.fn>;
  listPageConversations: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  postgres = new PGlite();
  await postgres.exec(`
    CREATE TABLE credentials (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, key_version text NOT NULL,
      wrapped_key bytea NOT NULL, wrapped_key_nonce bytea NOT NULL,
      wrapped_key_tag bytea NOT NULL, ciphertext bytea NOT NULL,
      nonce bytea NOT NULL, tag bytea NOT NULL, version integer NOT NULL DEFAULT 1,
      revoked_at timestamptz
    );
    CREATE TABLE provider_connections (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, credential_id uuid NOT NULL,
      grant_family text, scopes jsonb NOT NULL, status text NOT NULL,
      revoked_at timestamptz
    );
    CREATE TABLE provider_accounts (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, connection_id uuid NOT NULL,
      remote_account_id text NOT NULL, credential_id uuid, availability text NOT NULL,
      destination_provider text NOT NULL, disconnected_at timestamptz,
      capability_snapshot jsonb NOT NULL
    );
    CREATE TABLE facebook_page_engagement_modules (
      workspace_id uuid NOT NULL, account_id uuid NOT NULL,
      comments_enabled boolean NOT NULL, dms_enabled boolean NOT NULL,
      comments_provider_grant text NOT NULL, dms_provider_grant text NOT NULL,
      dms_credential_id uuid, dms_granted_scopes jsonb NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO publish_relay_app;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO publish_relay_app;
  `);
  const encrypted = await encryptCredential(
    Buffer.from(JSON.stringify({ pageId: '123', accessToken: 'page-secret' })),
    keys,
  );
  await postgres.query(
    `INSERT INTO credentials (
      id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
      wrapped_key_tag, ciphertext, nonce, tag
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      credentialId,
      workspaceId,
      encrypted.keyVersion,
      encrypted.wrappedKey,
      encrypted.wrappedKeyNonce,
      encrypted.wrappedKeyTag,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.tag,
    ],
  );
  await postgres.query(
    `INSERT INTO provider_connections VALUES ($1,$2,$3,'facebook_pages',$4,'active',NULL)`,
    [
      connectionId,
      workspaceId,
      credentialId,
      JSON.stringify([
        'pages_show_list',
        'pages_read_engagement',
        'pages_read_user_content',
        'pages_messaging',
        'pages_manage_metadata',
      ]),
    ],
  );
  for (const [id, pageId] of [
    [accountId, '123'],
    [siblingId, '999'],
  ]) {
    await postgres.query(
      `INSERT INTO provider_accounts VALUES ($1,$2,$3,$4,$5,'active','facebook_page',NULL,$6)`,
      [
        id,
        workspaceId,
        connectionId,
        pageId,
        credentialId,
        JSON.stringify({ tasks: ['CREATE_CONTENT', 'MESSAGING'] }),
      ],
    );
    await postgres.query(
      `INSERT INTO facebook_page_engagement_modules
        (workspace_id, account_id, comments_enabled, dms_enabled,
         comments_provider_grant, dms_provider_grant, dms_credential_id, dms_granted_scopes)
        VALUES ($1,$2,true,true,'verified','verified',$3,$4)`,
      [
        workspaceId,
        id,
        credentialId,
        JSON.stringify([
          'pages_show_list',
          'pages_read_engagement',
          'pages_messaging',
          'pages_manage_metadata',
        ]),
      ],
    );
  }
  for (const table of [
    'credentials',
    'provider_connections',
    'provider_accounts',
    'facebook_page_engagement_modules',
  ])
    await postgres.exec(`
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_scope ON ${table} TO publish_relay_app
      USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
  `);
  await postgres.exec('SET ROLE publish_relay_app;');
  database = drizzle(postgres) as unknown as NodePgDatabase;
  client = {
    listPagePosts: vi.fn().mockResolvedValue({ posts: [], nextCursor: null }),
    listPageConversations: vi.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
  };
});

afterEach(async () => postgres.close());

describe('Facebook Page read PostgreSQL tenant/account isolation', () => {
  it('reads only the selected origin Page with the matching encrypted Page credential', async () => {
    const runtime = { database, keys, client: client as never };
    expect(await listAccountPagePosts(runtime, { workspaceId, accountId })).toEqual({
      posts: [],
      nextCursor: null,
    });
    expect(await listAccountPageConversations(runtime, { workspaceId, accountId })).toEqual({
      conversations: [],
      nextCursor: null,
    });
    expect(client.listPagePosts).toHaveBeenCalledWith({
      pageId: '123',
      accessToken: 'page-secret',
    });
    expect(client.listPageConversations).toHaveBeenCalledWith({
      pageId: '123',
      accessToken: 'page-secret',
    });
  });

  it('denies cross-workspace, sibling Page token and revoked optional module before Graph', async () => {
    const runtime = { database, keys, client: client as never };
    await expect(
      listAccountPagePosts(runtime, { workspaceId: otherWorkspaceId, accountId }),
    ).rejects.toThrow('unavailable');
    await expect(
      listAccountPageConversations(runtime, { workspaceId, accountId: siblingId }),
    ).rejects.toThrow('unavailable');
    await postgres.exec('RESET ROLE;');
    await postgres.query(
      'UPDATE facebook_page_engagement_modules SET dms_enabled=false WHERE account_id=$1',
      [accountId],
    );
    await postgres.exec('SET ROLE publish_relay_app;');
    await expect(listAccountPageConversations(runtime, { workspaceId, accountId })).rejects.toThrow(
      'unavailable',
    );
    await postgres.exec('RESET ROLE;');
    await postgres.query(
      `UPDATE facebook_page_engagement_modules SET dms_enabled=true WHERE account_id=$1`,
      [accountId],
    );
    await postgres.query(
      `UPDATE facebook_page_engagement_modules
       SET dms_granted_scopes='["pages_show_list","pages_read_engagement"]'::jsonb
       WHERE account_id=$1`,
      [accountId],
    );
    await postgres.exec('SET ROLE publish_relay_app;');
    await expect(listAccountPageConversations(runtime, { workspaceId, accountId })).rejects.toThrow(
      'unavailable',
    );
    expect(client.listPagePosts).not.toHaveBeenCalled();
    expect(client.listPageConversations).not.toHaveBeenCalled();
  });
});
