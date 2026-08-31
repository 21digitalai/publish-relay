import {
  boolean,
  customType,
  integer,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const membershipRole = pgEnum('membership_role', ['owner', 'admin', 'editor', 'viewer']);
export const actorType = pgEnum('audit_actor_type', ['user', 'api_key', 'system']);

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  ...timestamps,
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    defaultWorkspaceId: uuid('default_workspace_id').references(() => workspaces.id, {
      onDelete: 'restrict',
    }),
    isDisabled: boolean('is_disabled').notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`)],
);

export const memberships = pgTable(
  'memberships',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index('memberships_user_idx').on(table.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    csrfSecretHash: text('csrf_secret_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('sessions_workspace_user_idx').on(table.workspaceId, table.userId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    label: text('label').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    capabilities: text('capabilities').array().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('api_keys_prefix_unique').on(table.prefix),
    index('api_keys_workspace_idx').on(table.workspaceId),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    requestId: text('request_id').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_workspace_created_idx').on(table.workspaceId, table.createdAt)],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('outbox_available_idx').on(table.availableAt)],
);

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    keyVersion: text('key_version').notNull(),
    wrappedKey: bytea('wrapped_key').notNull(),
    wrappedKeyNonce: bytea('wrapped_key_nonce').notNull(),
    wrappedKeyTag: bytea('wrapped_key_tag').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    tag: bytea('tag').notNull(),
    version: integer('version').notNull().default(1),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('credentials_workspace_idx').on(table.workspaceId)],
);

export const providerConnections = pgTable(
  'provider_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('active'),
    ...timestamps,
  },
  (table) => [index('provider_connections_workspace_idx').on(table.workspaceId)],
);

export const providerAccounts = pgTable(
  'provider_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    providerAccountId: text('provider_account_id').notNull(),
    displayName: text('display_name').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('provider_accounts_connection_external_unique').on(
      table.connectionId,
      table.providerAccountId,
    ),
    index('provider_accounts_workspace_idx').on(table.workspaceId),
  ],
);

export const oauthTransactions = pgTable(
  'oauth_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    stateHash: text('state_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('oauth_transactions_workspace_idx').on(table.workspaceId)],
);
