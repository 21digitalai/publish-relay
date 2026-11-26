import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
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
export const actorType = pgEnum('audit_actor_type', ['user', 'api_key', 'delegated', 'system']);
export const mediaState = pgEnum('media_state', [
  'temporary',
  'ready',
  'cleanup_eligible',
  'deleting',
  'cleanup_failed',
  'deleted',
]);
export const publicationJobState = pgEnum('publication_job_state', [
  'scheduled',
  'leased',
  'dispatching',
  'published',
  'accepted_pending',
  'retry_wait',
  'failed',
  'cancelled',
  'superseded',
]);
export const publicationAttemptOutcome = pgEnum('publication_attempt_outcome', [
  'published',
  'accepted_pending',
  'unknown',
  'auth',
  'rate_limit',
  'validation',
  'transient',
  'permanent',
]);

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timezone: text('timezone').notNull().default('UTC'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    reviewAccessExpiresAt: timestamp('review_access_expires_at', { withTimezone: true }),
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
    position: integer('position').notNull().default(0),
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

export const loginChallenges = pgTable(
  'login_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    emailKeyHash: text('email_key_hash').notNull(),
    networkKeyHash: text('network_key_hash').notNull(),
    userAgentHash: text('user_agent_hash').notNull(),
    purpose: text('purpose').notNull(),
    redirectPath: text('redirect_path').notNull().default('/app'),
    deliveryState: text('delivery_state').notNull().default('pending'),
    providerMessageId: text('provider_message_id'),
    correlationId: text('correlation_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('login_challenges_token_hash_unique').on(table.tokenHash),
    index('login_challenges_email_created_idx').on(table.emailKeyHash, table.createdAt),
    index('login_challenges_network_created_idx').on(table.networkKeyHash, table.createdAt),
    index('login_challenges_expiry_idx').on(table.expiresAt),
    check('login_challenges_purpose_check', sql`${table.purpose} in ('login', 'signup')`),
    check(
      'login_challenges_delivery_state_check',
      sql`${table.deliveryState} in ('pending', 'sent', 'suppressed', 'failed')`,
    ),
    check(
      'login_challenges_redirect_check',
      sql`${table.redirectPath} like '/%' and ${table.redirectPath} not like '//%'`,
    ),
  ],
);

export const authRateLimitBuckets = pgTable(
  'auth_rate_limit_buckets',
  {
    keyHash: text('key_hash').notNull(),
    kind: text('kind').notNull(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    requestCount: integer('request_count').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.keyHash, table.windowStartedAt] }),
    index('auth_rate_limit_buckets_expiry_idx').on(table.expiresAt),
    check('auth_rate_limit_buckets_kind_check', sql`${table.kind} in ('email', 'network')`),
    check('auth_rate_limit_buckets_count_check', sql`${table.requestCount} > 0`),
  ],
);

export const authEmailOutbox = pgTable(
  'auth_email_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    challengeId: uuid('challenge_id')
      .notNull()
      .references(() => loginChallenges.id, { onDelete: 'cascade' }),
    keyVersion: text('key_version').notNull(),
    wrappedKey: bytea('wrapped_key').notNull(),
    wrappedKeyNonce: bytea('wrapped_key_nonce').notNull(),
    wrappedKeyTag: bytea('wrapped_key_tag').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    tag: bytea('tag').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('auth_email_outbox_challenge_unique').on(table.challengeId),
    index('auth_email_outbox_available_idx').on(table.availableAt, table.leaseExpiresAt),
  ],
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
    capabilityVersion: integer('capability_version').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('api_keys_prefix_unique').on(table.prefix),
    uniqueIndex('api_keys_workspace_id_unique').on(table.workspaceId, table.id),
    index('api_keys_workspace_idx').on(table.workspaceId),
  ],
);

export const registeredClients = pgTable('registered_clients', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  clientType: text('client_type').notNull(),
  secretHash: text('secret_hash'),
  redirectUris: text('redirect_uris').array().notNull(),
  allowedScopes: text('allowed_scopes').array().notNull(),
  ...timestamps,
});

export const delegatedGrants = pgTable(
  'delegated_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => registeredClients.id, { onDelete: 'restrict' }),
    scopes: text('scopes').array().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('delegated_grants_workspace_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('delegated_grants_active_identity_unique')
      .on(table.workspaceId, table.userId, table.clientId)
      .where(sql`${table.revokedAt} is null`),
    index('delegated_grants_workspace_user_idx').on(table.workspaceId, table.userId),
    index('delegated_grants_workspace_client_idx').on(table.workspaceId, table.clientId),
  ],
);

export const delegatedAuthorizationCodes = pgTable(
  'delegated_authorization_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    grantId: uuid('grant_id').notNull(),
    clientId: text('client_id').notNull(),
    codeHash: text('code_hash').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    scopes: text('scopes').array().notNull(),
    codeChallenge: text('code_challenge').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('delegated_authorization_codes_hash_unique').on(table.codeHash),
    index('delegated_authorization_codes_expiry_idx').on(table.workspaceId, table.expiresAt),
    foreignKey({
      columns: [table.workspaceId, table.grantId],
      foreignColumns: [delegatedGrants.workspaceId, delegatedGrants.id],
      name: 'delegated_authorization_codes_workspace_grant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [registeredClients.id],
      name: 'delegated_authorization_codes_client_fk',
    }).onDelete('restrict'),
  ],
);

export const delegatedTokens = pgTable(
  'delegated_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    grantId: uuid('grant_id').notNull(),
    accessTokenHash: text('access_token_hash').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    rotatedFromTokenId: uuid('rotated_from_token_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('delegated_tokens_access_hash_unique').on(table.accessTokenHash),
    uniqueIndex('delegated_tokens_refresh_hash_unique').on(table.refreshTokenHash),
    index('delegated_tokens_workspace_grant_idx').on(table.workspaceId, table.grantId),
    foreignKey({
      columns: [table.workspaceId, table.grantId],
      foreignColumns: [delegatedGrants.workspaceId, delegatedGrants.id],
      name: 'delegated_tokens_workspace_grant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.rotatedFromTokenId],
      foreignColumns: [table.id],
      name: 'delegated_tokens_rotated_from_fk',
    }).onDelete('set null'),
  ],
);

export const apiMutationResults = pgTable(
  'api_mutation_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    statusCode: integer('status_code').notNull(),
    responseBody: jsonb('response_body').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('api_mutation_results_scope_unique').on(
      table.workspaceId,
      table.actorType,
      table.actorId,
      table.operation,
      table.idempotencyKey,
    ),
    index('api_mutation_results_workspace_created_idx').on(table.workspaceId, table.createdAt),
  ],
);

export const browserMutationResults = pgTable(
  'browser_mutation_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    statusCode: integer('status_code').notNull(),
    responseBody: jsonb('response_body').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('browser_mutation_results_scope_unique').on(
      table.workspaceId,
      table.userId,
      table.operation,
      table.idempotencyKey,
    ),
    index('browser_mutation_results_workspace_created_idx').on(table.workspaceId, table.createdAt),
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
  (table) => [
    index('credentials_workspace_idx').on(table.workspaceId),
    uniqueIndex('credentials_workspace_id_unique').on(table.workspaceId, table.id),
  ],
);

export const providerConnections = pgTable(
  'provider_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    grantFamily: text('grant_family'),
    memberUrn: text('member_urn'),
    externalSubjectId: text('external_subject_id')
      .notNull()
      .default(sql`'legacy:' || gen_random_uuid()::text`),
    scopes: jsonb('scopes').notNull().default([]),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('provider_connections_workspace_idx').on(table.workspaceId),
    uniqueIndex('provider_connections_workspace_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('provider_connections_workspace_subject_unique').on(
      table.workspaceId,
      table.provider,
      table.externalSubjectId,
      sql`COALESCE(${table.grantFamily}, 'legacy')`,
    ),
    check(
      'provider_connections_meta_grant_family_valid',
      sql`${table.grantFamily} IS NULL OR (${table.provider} = 'meta' AND ${table.grantFamily} IN ('facebook_pages', 'instagram'))`,
    ),
    uniqueIndex('provider_connections_linkedin_member_unique')
      .on(table.workspaceId, table.memberUrn)
      .where(sql`${table.provider} = 'linkedin'`),
    check(
      'provider_connections_linkedin_member_required',
      sql`${table.provider} <> 'linkedin' OR ${table.memberUrn} IS NOT NULL`,
    ),
  ],
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
    destinationProvider: text('destination_provider').notNull(),
    remoteAccountId: text('remote_account_id').notNull(),
    remoteParentAccountId: text('remote_parent_account_id'),
    credentialId: uuid('credential_id'),
    capabilitySnapshot: jsonb('capability_snapshot').notNull().default({}),
    capabilitiesCheckedAt: timestamp('capabilities_checked_at', { withTimezone: true }),
    availability: text('availability').notNull().default('active'),
    displayName: text('display_name').notNull(),
    adapterDefaults: jsonb('adapter_defaults').notNull().default({}),
    xLongPostsAllowed: boolean('x_long_posts_allowed').notNull().default(false),
    fanvueAgentGuidance: text('fanvue_agent_guidance').notNull().default(''),
    facebookPageProfile: text('facebook_page_profile').notNull().default(''),
    facebookPageDmGuidance: text('facebook_page_dm_guidance').notNull().default(''),
    facebookPageCommentGuidance: text('facebook_page_comment_guidance').notNull().default(''),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('provider_accounts_workspace_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('provider_accounts_connection_destination_remote_unique').on(
      table.connectionId,
      table.destinationProvider,
      table.remoteAccountId,
    ),
    index('provider_accounts_workspace_idx').on(table.workspaceId),
    foreignKey({
      columns: [table.workspaceId, table.connectionId],
      foreignColumns: [providerConnections.workspaceId, providerConnections.id],
      name: 'provider_accounts_workspace_connection_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.credentialId],
      foreignColumns: [credentials.workspaceId, credentials.id],
      name: 'provider_accounts_workspace_credential_fk',
    }).onDelete('restrict'),
  ],
);

export const facebookPageDmDelaySettings = pgTable(
  'facebook_page_dm_delay_settings',
  {
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    earliestDelaySeconds: integer('earliest_delay_seconds').notNull().default(300),
    latestDelaySeconds: integer('latest_delay_seconds').notNull().default(2700),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.accountId] }),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'facebook_page_dm_delay_settings_account_fk',
    }).onDelete('cascade'),
  ],
);

export const facebookPageEngagementModules = pgTable(
  'facebook_page_engagement_modules',
  {
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    commentsEnabled: boolean('comments_enabled').notNull().default(false),
    dmsEnabled: boolean('dms_enabled').notNull().default(false),
    dmDailyGroupLimitEnabled: boolean('dm_daily_group_limit_enabled').notNull().default(false),
    dmDailyGroupMaximum: integer('dm_daily_group_maximum').notNull().default(1),
    dmRootPacingMinimumSeconds: integer('dm_root_pacing_minimum_seconds').notNull().default(60),
    dmRootPacingMaximumSeconds: integer('dm_root_pacing_maximum_seconds').notNull().default(120),
    commentsProviderGrant: text('comments_provider_grant').notNull().default('unknown'),
    commentsCredentialId: uuid('comments_credential_id'),
    commentsGrantedScopes: jsonb('comments_granted_scopes').notNull().default([]),
    dmsProviderGrant: text('dms_provider_grant').notNull().default('unknown'),
    dmsCredentialId: uuid('dms_credential_id'),
    dmsGrantedScopes: jsonb('dms_granted_scopes').notNull().default([]),
    commentsVerifiedAt: timestamp('comments_verified_at', { withTimezone: true }),
    dmsVerifiedAt: timestamp('dms_verified_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.accountId] }),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'facebook_page_engagement_account_fk',
    }).onDelete('cascade'),
    check(
      'facebook_page_engagement_comments_grant_check',
      sql`${table.commentsProviderGrant} IN ('unknown', 'missing', 'verified')`,
    ),
    check(
      'facebook_page_engagement_dms_grant_check',
      sql`${table.dmsProviderGrant} IN ('unknown', 'missing', 'verified')`,
    ),
    check(
      'facebook_page_engagement_dm_daily_group_maximum_check',
      sql`${table.dmDailyGroupMaximum} IN (1, 2)`,
    ),
    check(
      'facebook_page_engagement_dm_root_pacing_check',
      sql`${table.dmRootPacingMinimumSeconds} >= 60 AND ${table.dmRootPacingMaximumSeconds} >= ${table.dmRootPacingMinimumSeconds} AND ${table.dmRootPacingMaximumSeconds} <= 600`,
    ),
    check(
      'facebook_page_engagement_comments_evidence_check',
      sql`(${table.commentsProviderGrant} = 'verified') = (${table.commentsVerifiedAt} IS NOT NULL AND ${table.commentsCredentialId} IS NOT NULL)`,
    ),
    check(
      'facebook_page_engagement_dms_evidence_check',
      sql`(${table.dmsProviderGrant} = 'verified') = (${table.dmsVerifiedAt} IS NOT NULL AND ${table.dmsCredentialId} IS NOT NULL)`,
    ),
    foreignKey({
      columns: [table.workspaceId, table.commentsCredentialId],
      foreignColumns: [credentials.workspaceId, credentials.id],
      name: 'facebook_page_engagement_comments_credential_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.dmsCredentialId],
      foreignColumns: [credentials.workspaceId, credentials.id],
      name: 'facebook_page_engagement_dms_credential_fk',
    }).onDelete('restrict'),
  ],
);

export const facebookPageEngagementGrants = pgTable(
  'facebook_page_engagement_grants',
  {
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    apiKeyId: uuid('api_key_id'),
    delegatedGrantId: uuid('delegated_grant_id'),
    capability: text('capability').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'facebook_page_engagement_principal_check',
      sql`(${table.apiKeyId} IS NOT NULL) <> (${table.delegatedGrantId} IS NOT NULL)`,
    ),
    check(
      'facebook_page_engagement_capability_check',
      sql`${table.capability} IN ('comments:read', 'comments:propose', 'comments:send', 'dms:read', 'dms:propose', 'dms:send')`,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [
        facebookPageEngagementModules.workspaceId,
        facebookPageEngagementModules.accountId,
      ],
      name: 'facebook_page_engagement_grants_account_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.apiKeyId],
      foreignColumns: [apiKeys.workspaceId, apiKeys.id],
      name: 'facebook_page_engagement_grants_api_key_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.delegatedGrantId],
      foreignColumns: [delegatedGrants.workspaceId, delegatedGrants.id],
      name: 'facebook_page_engagement_grants_delegated_fk',
    }).onDelete('cascade'),
    uniqueIndex('facebook_page_engagement_api_key_grant_unique')
      .on(table.workspaceId, table.accountId, table.apiKeyId, table.capability)
      .where(sql`${table.apiKeyId} IS NOT NULL`),
    uniqueIndex('facebook_page_engagement_delegated_grant_unique')
      .on(table.workspaceId, table.accountId, table.delegatedGrantId, table.capability)
      .where(sql`${table.delegatedGrantId} IS NOT NULL`),
  ],
);

export const facebookPageDmActions = pgTable(
  'facebook_page_dm_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    clientActionId: uuid('client_action_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    receiverLabel: text('receiver_label'),
    textBody: text('text_body'),
    requestFingerprint: text('request_fingerprint').notNull(),
    state: text('state').notNull().default('reserved'),
    providerMessageId: text('provider_message_id'),
    failureStatus: integer('failure_status'),
    failureCode: integer('failure_code'),
    failureSubcode: integer('failure_subcode'),
    failureTraceId: text('failure_trace_id'),
    failureTransient: boolean('failure_transient'),
    finalExit: boolean('final_exit').notNull().default(false),
    bioLinkMention: boolean('bio_link_mention').notNull().default(false),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('facebook_page_dm_actions_workspace_action_unique').on(
      table.workspaceId,
      table.clientActionId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'facebook_page_dm_actions_account_fk',
    }).onDelete('restrict'),
    check(
      'facebook_page_dm_actions_state_check',
      sql`${table.state} IN ('reserved', 'confirmed', 'failed', 'unknown')`,
    ),
  ],
);

export const instagramUnifiedActions = pgTable(
  'instagram_unified_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    clientActionId: uuid('client_action_id').notNull(),
    kind: text('kind').notNull(),
    targetId: text('target_id').notNull(),
    parentId: text('parent_id').notNull(),
    recipientId: text('recipient_id'),
    textBody: text('text_body').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    state: text('state').notNull().default('reserved'),
    providerReceipt: text('provider_receipt'),
    failureStatus: integer('failure_status'),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('instagram_unified_actions_workspace_action_unique').on(table.workspaceId, table.clientActionId),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'instagram_unified_actions_account_fk',
    }).onDelete('restrict'),
    check('instagram_unified_actions_kind_check', sql`${table.kind} IN ('comment_reply', 'dm_reply')`),
    check('instagram_unified_actions_state_check', sql`${table.state} IN ('reserved', 'confirmed', 'failed', 'unknown')`),
    check('instagram_unified_actions_text_check', sql`length(trim(${table.textBody})) BETWEEN 1 AND 2000`),
  ],
);

export const facebookPageDmPendingIntents = pgTable(
  'facebook_page_dm_pending_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    clientActionId: uuid('client_action_id').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    textBody: text('text_body').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    windowDeadline: timestamp('window_deadline', { withTimezone: true }),
    groupId: uuid('group_id'),
    sequenceIndex: integer('sequence_index'),
    gapSeconds: integer('gap_seconds'),
    expectedLatestInboundMessageId: text('expected_latest_inbound_message_id'),
    finalExit: boolean('final_exit').notNull().default(false),
    bioLinkMention: boolean('bio_link_mention').notNull().default(false),
    preSendAttempts: integer('pre_send_attempts').notNull().default(0),
    status: text('status').notNull().default('pending'),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('facebook_page_dm_pending_intents_action_unique').on(
      table.workspaceId,
      table.clientActionId,
    ),
    index('facebook_page_dm_pending_intents_due_idx').on(table.dueAt, table.id),
    uniqueIndex('facebook_page_dm_pending_intents_group_sequence_unique').on(
      table.workspaceId,
      table.groupId,
      table.sequenceIndex,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'facebook_page_dm_pending_intents_account_fk',
    }).onDelete('restrict'),
    check(
      'facebook_page_dm_pending_intents_status_check',
      sql`${table.status} IN ('waiting', 'pending', 'claimed', 'cancelled', 'confirmed', 'failed', 'unknown')`,
    ),
    check(
      'facebook_page_dm_pending_intents_text_check',
      sql`length(trim(${table.textBody})) BETWEEN 1 AND 2000`,
    ),
    check(
      'facebook_page_dm_pending_intents_lease_check',
      sql`(${table.status} = 'claimed') = (${table.leaseOwner} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL)`,
    ),
  ],
);

export const facebookPageDmDispatchPacing = pgTable(
  'facebook_page_dm_dispatch_pacing',
  {
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    nextRootAt: timestamp('next_root_at', { withTimezone: true }).notNull(),
    lastRootId: uuid('last_root_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.accountId] }),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'facebook_page_dm_dispatch_pacing_account_fk',
    }).onDelete('cascade'),
  ],
);

export const facebookPageDmNoGo = pgTable(
  'facebook_page_dm_no_go',
  {
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    displayName: text('display_name'),
    reason: text('reason').notNull().default('manual'),
    finalActionId: uuid('final_action_id'),
    finalMessageId: text('final_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.accountId, table.conversationId] }),
    check(
      'facebook_page_dm_no_go_reason_check',
      sql`${table.reason} IN ('manual', 'campaign_final')`,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'facebook_page_dm_no_go_account_fk',
    }).onDelete('cascade'),
  ],
);

export const facebookPageDmFailureCircuit = pgTable(
  'facebook_page_dm_failure_circuit',
  {
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    haltedAt: timestamp('halted_at', { withTimezone: true }),
    lastActionId: uuid('last_action_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.accountId] }),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'facebook_page_dm_failure_circuit_account_fk',
    }).onDelete('cascade'),
    check('facebook_page_dm_failure_circuit_count_check', sql`${table.consecutiveFailures} >= 0`),
  ],
);

export const facebookPageDmMemory = pgTable(
  'facebook_page_dm_memory',
  {
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    facts: jsonb('facts').$type<string[]>().notNull().default([]),
    firstContactAt: timestamp('first_contact_at', { withTimezone: true }),
    lastProcessedInboundId: text('last_processed_inbound_id'),
    lastOutboundReceiptRef: text('last_outbound_receipt_ref'),
    finalExitAt: timestamp('final_exit_at', { withTimezone: true }),
    finalActionId: uuid('final_action_id'),
    finalMessageId: text('final_message_id'),
    bioLinkMentionAt: timestamp('bio_link_mention_at', { withTimezone: true }),
    bioLinkActionId: uuid('bio_link_action_id'),
    bioLinkMessageId: text('bio_link_message_id'),
    terminal: boolean('terminal').notNull().default(false),
    unansweredFollowUp: boolean('unanswered_follow_up').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.accountId, table.conversationId] }),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'facebook_page_dm_memory_account_fk',
    }).onDelete('cascade'),
  ],
);

export const facebookPageDmActiveDays = pgTable(
  'facebook_page_dm_active_days',
  {
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    civilDay: text('civil_day').notNull(),
    inboundMessageId: text('inbound_message_id').notNull(),
    inboundAt: timestamp('inbound_at', { withTimezone: true }).notNull(),
    outboundActionId: uuid('outbound_action_id').notNull(),
    outboundMessageId: text('outbound_message_id').notNull(),
    outboundAt: timestamp('outbound_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.accountId, table.conversationId, table.civilDay],
    }),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'facebook_page_dm_active_days_account_fk',
    }).onDelete('cascade'),
  ],
);

export const facebookPageCommentActions = pgTable(
  'facebook_page_comment_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    clientActionId: uuid('client_action_id').notNull(),
    commentId: text('comment_id').notNull(),
    postId: text('post_id'),
    textBody: text('text_body'),
    requestFingerprint: text('request_fingerprint').notNull(),
    state: text('state').notNull().default('reserved'),
    providerCommentId: text('provider_comment_id'),
    failureStatus: integer('failure_status'),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('facebook_page_comment_actions_workspace_action_unique').on(
      table.workspaceId,
      table.clientActionId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'facebook_page_comment_actions_account_fk',
    }).onDelete('restrict'),
    check(
      'facebook_page_comment_actions_state_check',
      sql`${table.state} IN ('reserved', 'confirmed', 'failed', 'unknown')`,
    ),
  ],
);

export const facebookPageCommentPendingIntents = pgTable(
  'facebook_page_comment_pending_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    postId: text('post_id').notNull(),
    commentId: text('comment_id').notNull(),
    clientActionId: uuid('client_action_id').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    textBody: text('text_body').notNull(),
    targetText: text('target_text').notNull(),
    targetCreatedAt: text('target_created_at').notNull(),
    threadFingerprint: text('thread_fingerprint').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('pending'),
    preSendAttempts: integer('pre_send_attempts').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('facebook_page_comment_pending_intents_action_unique').on(
      table.workspaceId,
      table.clientActionId,
    ),
    uniqueIndex('facebook_page_comment_pending_intents_active_comment_unique')
      .on(table.workspaceId, table.accountId, table.commentId)
      .where(sql`${table.status} IN ('pending', 'claimed', 'confirmed', 'unknown')`),
    index('facebook_page_comment_pending_intents_due_idx')
      .on(table.dueAt, table.id)
      .where(sql`${table.status} IN ('pending', 'claimed')`),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'facebook_page_comment_pending_intents_account_fk',
    }).onDelete('restrict'),
    check(
      'facebook_page_comment_pending_intents_status_check',
      sql`${table.status} IN ('pending', 'claimed', 'cancelled', 'confirmed', 'failed', 'unknown')`,
    ),
    check(
      'facebook_page_comment_pending_intents_text_check',
      sql`length(trim(${table.textBody})) BETWEEN 1 AND 2000`,
    ),
    check(
      'facebook_page_comment_pending_intents_lease_check',
      sql`(${table.status} = 'claimed') = (${table.leaseOwner} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL)`,
    ),
  ],
);

export const facebookPageCommentDispatchPacing = pgTable(
  'facebook_page_comment_dispatch_pacing',
  {
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    nextAt: timestamp('next_at', { withTimezone: true }).notNull(),
    lastIntentId: uuid('last_intent_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.accountId] }),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
    }).onDelete('cascade'),
  ],
);

// Provider-neutral review-first queue. Approval uses the canonical provider command, not this row.
export const engagementProposals = pgTable(
  'engagement_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    clientActionId: uuid('client_action_id').notNull(),
    provider: text('provider').notNull(),
    kind: text('kind').notNull(),
    targetId: text('target_id').notNull(),
    sourceContext: jsonb('source_context').notNull().default({}),
    content: jsonb('content').notNull(),
    plannedDueAt: timestamp('planned_due_at', { withTimezone: true }),
    proposerType: text('proposer_type').notNull(),
    proposerId: uuid('proposer_id').notNull(),
    status: text('status').notNull().default('pending'),
    revision: integer('revision').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('engagement_proposals_workspace_action_unique').on(
      table.workspaceId,
      table.clientActionId,
    ),
    uniqueIndex('engagement_proposals_workspace_id_unique').on(table.workspaceId, table.id),
    index('engagement_proposals_pending_idx').on(table.workspaceId, table.createdAt),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'engagement_proposals_account_fk',
    }).onDelete('restrict'),
  ],
);

// Exposure grants selectability without moving the canonical account or credential.
export const providerAccountExposures = pgTable(
  'provider_account_exposures',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    showOtherWorkspacePosts: boolean('show_other_workspace_posts').notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.providerAccountId] }),
    index('provider_account_exposures_account_idx').on(table.providerAccountId),
  ],
);

export const providerCapabilitySnapshots = pgTable(
  'provider_capability_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    externalSubjectId: text('external_subject_id').notNull(),
    credentialVersion: integer('credential_version').notNull(),
    nickname: text('nickname').notNull(),
    privacyOptions: jsonb('privacy_options').$type<string[]>().notNull(),
    commentDisabled: boolean('comment_disabled').notNull(),
    duetDisabled: boolean('duet_disabled').notNull(),
    stitchDisabled: boolean('stitch_disabled').notNull(),
    maxVideoDurationSeconds: integer('max_video_duration_seconds').notNull(),
    providerLogId: text('provider_log_id'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('provider_capability_snapshots_workspace_id_unique').on(
      table.workspaceId,
      table.id,
    ),
    index('provider_capability_snapshots_account_fetched_idx').on(
      table.workspaceId,
      table.accountId,
      table.fetchedAt,
    ),
    index('provider_capability_snapshots_expiry_idx').on(table.workspaceId, table.expiresAt),
    check(
      'provider_capability_snapshots_duration_check',
      sql`${table.maxVideoDurationSeconds} > 0`,
    ),
    check(
      'provider_capability_snapshots_expiry_check',
      sql`${table.expiresAt} > ${table.fetchedAt}`,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'provider_capability_snapshots_workspace_account_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.connectionId],
      foreignColumns: [providerConnections.workspaceId, providerConnections.id],
      name: 'provider_capability_snapshots_workspace_connection_fk',
    }).onDelete('cascade'),
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
    secretCredentialId: uuid('secret_credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'restrict' }),
    redirectUri: text('redirect_uri').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('oauth_transactions_workspace_idx').on(table.workspaceId)],
);

export const mediaObjects = pgTable(
  'media_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    videoCodec: text('video_codec'),
    audioCodec: text('audio_codec'),
    container: text('container'),
    state: mediaState('state').notNull().default('temporary'),
    retainedAt: timestamp('retained_at', { withTimezone: true }),
    cleanupEligibleAt: timestamp('cleanup_eligible_at', { withTimezone: true }),
    cleanupStartedAt: timestamp('cleanup_started_at', { withTimezone: true }),
    cleanupFailedAt: timestamp('cleanup_failed_at', { withTimezone: true }),
    cleanupRetryAt: timestamp('cleanup_retry_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletionAttempts: integer('deletion_attempts').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('media_objects_workspace_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('media_objects_workspace_storage_unique').on(table.workspaceId, table.storageKey),
    index('media_objects_workspace_state_idx').on(table.workspaceId, table.state),
  ],
);

export const externalDrafts = pgTable(
  'external_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceActorType: actorType('source_actor_type').notNull(),
    sourceActorId: uuid('source_actor_id').notNull(),
    sourceClientId: text('source_client_id').references(() => registeredClients.id, {
      onDelete: 'restrict',
    }),
    externalId: text('external_id').notNull(),
    label: text('label'),
    returnUrl: text('return_url'),
    requestFingerprint: text('request_fingerprint').notNull(),
    postId: uuid('post_id'),
    transitionedAt: timestamp('transitioned_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('external_drafts_workspace_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('external_drafts_source_external_unique').on(
      table.workspaceId,
      table.sourceActorType,
      table.sourceActorId,
      table.externalId,
    ),
    index('external_drafts_workspace_created_idx').on(table.workspaceId, table.createdAt),
    foreignKey({
      columns: [table.workspaceId, table.postId],
      foreignColumns: [posts.workspaceId, posts.id],
      name: 'external_drafts_workspace_post_fk',
    }).onDelete('restrict'),
  ],
);

export const externalDraftMedia = pgTable(
  'external_draft_media',
  {
    workspaceId: uuid('workspace_id').notNull(),
    draftId: uuid('draft_id').notNull(),
    mediaId: uuid('media_id').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.mediaId] }),
    uniqueIndex('external_draft_media_position_unique').on(table.draftId, table.position),
    index('external_draft_media_workspace_idx').on(table.workspaceId),
    foreignKey({
      columns: [table.workspaceId, table.draftId],
      foreignColumns: [externalDrafts.workspaceId, externalDrafts.id],
      name: 'external_draft_media_workspace_draft_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.mediaId],
      foreignColumns: [mediaObjects.workspaceId, mediaObjects.id],
      name: 'external_draft_media_workspace_media_fk',
    }).onDelete('restrict'),
  ],
);

export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdActorType: actorType('created_actor_type'),
    createdActorId: uuid('created_actor_id'),
    lastMutatorType: actorType('last_mutator_type'),
    lastMutatorId: uuid('last_mutator_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('posts_workspace_id_unique').on(table.workspaceId, table.id),
    index('posts_workspace_updated_idx').on(table.workspaceId, table.updatedAt),
  ],
);

export const postRevisions = pgTable(
  'post_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    content: jsonb('content').notNull(),
    createdActorType: actorType('created_actor_type'),
    createdActorId: uuid('created_actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('post_revisions_workspace_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('post_revisions_post_number_unique').on(table.postId, table.revisionNumber),
    index('post_revisions_workspace_idx').on(table.workspaceId),
    foreignKey({
      columns: [table.workspaceId, table.postId],
      foreignColumns: [posts.workspaceId, posts.id],
      name: 'post_revisions_workspace_post_fk',
    }).onDelete('cascade'),
  ],
);

export const revisionMedia = pgTable(
  'revision_media',
  {
    workspaceId: uuid('workspace_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    mediaId: uuid('media_id').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.mediaId] }),
    uniqueIndex('revision_media_position_unique').on(table.revisionId, table.position),
    index('revision_media_workspace_idx').on(table.workspaceId),
    foreignKey({
      columns: [table.workspaceId, table.revisionId],
      foreignColumns: [postRevisions.workspaceId, postRevisions.id],
      name: 'revision_media_workspace_revision_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.mediaId],
      foreignColumns: [mediaObjects.workspaceId, mediaObjects.id],
      name: 'revision_media_workspace_media_fk',
    }).onDelete('restrict'),
  ],
);

export const publicationConsents = pgTable(
  'publication_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    postId: uuid('post_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    accountId: uuid('account_id').notNull(),
    mediaId: uuid('media_id').notNull(),
    mediaSha256: text('media_sha256').notNull(),
    capabilitySnapshotId: uuid('capability_snapshot_id').notNull(),
    credentialVersion: integer('credential_version').notNull(),
    declarationVersion: integer('declaration_version').notNull(),
    payload: jsonb('payload').notNull(),
    payloadHash: text('payload_hash').notNull(),
    consentedAt: timestamp('consented_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('publication_consents_workspace_id_unique').on(table.workspaceId, table.id),
    index('publication_consents_revision_idx').on(table.workspaceId, table.revisionId),
    foreignKey({
      columns: [table.workspaceId, table.postId],
      foreignColumns: [posts.workspaceId, posts.id],
      name: 'publication_consents_workspace_post_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.revisionId],
      foreignColumns: [postRevisions.workspaceId, postRevisions.id],
      name: 'publication_consents_workspace_revision_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'publication_consents_workspace_account_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.mediaId],
      foreignColumns: [mediaObjects.workspaceId, mediaObjects.id],
      name: 'publication_consents_workspace_media_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.capabilitySnapshotId],
      foreignColumns: [providerCapabilitySnapshots.workspaceId, providerCapabilitySnapshots.id],
      name: 'publication_consents_workspace_snapshot_fk',
    }).onDelete('restrict'),
  ],
);

export const providerMediaGrants = pgTable(
  'provider_media_grants',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    mediaId: uuid('media_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    mediaSha256: text('media_sha256').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('provider_media_grants_workspace_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('provider_media_grants_token_hash_unique').on(table.tokenHash),
    index('provider_media_grants_media_expiry_idx').on(
      table.workspaceId,
      table.mediaId,
      table.expiresAt,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'provider_media_grants_workspace_account_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.mediaId],
      foreignColumns: [mediaObjects.workspaceId, mediaObjects.id],
      name: 'provider_media_grants_workspace_media_fk',
    }).onDelete('restrict'),
  ],
);

export const publicationJobs = pgTable(
  'publication_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    providerAccountId: uuid('provider_account_id').notNull(),
    effectivePayload: jsonb('effective_payload'),
    effectiveProviderSettings: jsonb('effective_provider_settings'),
    state: publicationJobState('state').notNull().default('scheduled'),
    approvalRequired: boolean('approval_required').notNull().default(false),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByUserId: uuid('approved_by_user_id'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    attemptNumber: integer('attempt_number').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    reconciliationRequired: boolean('reconciliation_required').notNull().default(false),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('publication_jobs_workspace_id_unique').on(table.workspaceId, table.id),
    index('publication_jobs_workspace_due_idx').on(
      table.workspaceId,
      table.state,
      table.scheduledAt,
    ),
    index('publication_jobs_post_idx').on(table.postId),
    index('publication_jobs_lease_expiry_idx').on(table.workspaceId, table.leaseExpiresAt),
    foreignKey({
      columns: [table.workspaceId, table.postId],
      foreignColumns: [posts.workspaceId, posts.id],
      name: 'publication_jobs_workspace_post_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.revisionId],
      foreignColumns: [postRevisions.workspaceId, postRevisions.id],
      name: 'publication_jobs_workspace_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.providerAccountId],
      foreignColumns: [
        providerAccountExposures.workspaceId,
        providerAccountExposures.providerAccountId,
      ],
      name: 'publication_jobs_workspace_exposure_fk',
    }).onDelete('restrict'),
  ],
);

export const publicationAttempts = pgTable(
  'publication_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    tiktokInitPhase: text('tiktok_init_phase'),
    tiktokMediaGrantId: uuid('tiktok_media_grant_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    outcome: publicationAttemptOutcome('outcome'),
    providerRequestId: text('provider_request_id'),
    externalPostId: text('external_post_id'),
    externalUrl: text('external_url'),
    reconciliationKey: text('reconciliation_key'),
    retryAt: timestamp('retry_at', { withTimezone: true }),
    redactedError: text('redacted_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('publication_attempts_workspace_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('publication_attempts_job_number_unique').on(table.jobId, table.attemptNumber),
    uniqueIndex('publication_attempts_tiktok_grant_unique')
      .on(table.tiktokMediaGrantId)
      .where(sql`${table.tiktokMediaGrantId} IS NOT NULL`),
    index('publication_attempts_idempotency_idx').on(table.workspaceId, table.idempotencyKey),
    index('publication_attempts_reconciliation_idx').on(table.workspaceId, table.reconciliationKey),
    foreignKey({
      columns: [table.workspaceId, table.jobId],
      foreignColumns: [publicationJobs.workspaceId, publicationJobs.id],
      name: 'publication_attempts_workspace_job_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.tiktokMediaGrantId],
      foreignColumns: [providerMediaGrants.workspaceId, providerMediaGrants.id],
      name: 'publication_attempts_tiktok_grant_fk',
    }).onDelete('restrict'),
  ],
);

export const xThreadParts = pgTable(
  'x_thread_parts',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').notNull(),
    position: integer('position').notNull(),
    dispatchKey: text('dispatch_key').notNull(),
    state: text('state').notNull(),
    dispatchStartedAt: timestamp('dispatch_started_at', { withTimezone: true }).notNull(),
    externalPostId: text('external_post_id'),
    externalUrl: text('external_url'),
    replyToPostId: text('reply_to_post_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.jobId, table.position],
      name: 'x_thread_parts_workspace_id_job_id_position_pk',
    }),
    uniqueIndex('x_thread_parts_external_post_unique').on(table.workspaceId, table.externalPostId),
    uniqueIndex('x_thread_parts_dispatch_key_unique').on(table.workspaceId, table.dispatchKey),
    foreignKey({
      columns: [table.workspaceId, table.jobId],
      foreignColumns: [publicationJobs.workspaceId, publicationJobs.id],
      name: 'x_thread_parts_workspace_job_fk',
    }).onDelete('cascade'),
    check('x_thread_parts_position_nonnegative', sql`${table.position} >= 0`),
    check('x_thread_parts_state_valid', sql`${table.state} in ('dispatching', 'published')`),
  ],
);

export const xRemediationJournals = pgTable(
  'x_remediation_journals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    sourceJobId: uuid('source_job_id').notNull(),
    sourceAttemptId: uuid('source_attempt_id').notNull(),
    sourceExternalPostId: text('source_external_post_id').notNull(),
    sourceRevisionId: uuid('source_revision_id').notNull(),
    sourceContentHash: text('source_content_hash').notNull(),
    sourceMediaHashes: jsonb('source_media_hashes').notNull(),
    phase: text('phase').notNull(),
    deleteStartedAt: timestamp('delete_started_at', { withTimezone: true }),
    deleteConfirmedAt: timestamp('delete_confirmed_at', { withTimezone: true }),
    replacementJobId: uuid('replacement_job_id'),
    replacementAttemptId: uuid('replacement_attempt_id'),
    replacementExternalPostId: text('replacement_external_post_id'),
    replacementExternalUrl: text('replacement_external_url'),
    replacementStartedAt: timestamp('replacement_started_at', { withTimezone: true }),
    replacementConfirmedAt: timestamp('replacement_confirmed_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('x_remediation_journals_source_job_unique').on(table.sourceJobId),
    index('x_remediation_journals_workspace_phase_idx').on(table.workspaceId, table.phase),
    foreignKey({
      columns: [table.workspaceId, table.sourceJobId],
      foreignColumns: [publicationJobs.workspaceId, publicationJobs.id],
      name: 'x_remediation_journals_source_job_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.sourceAttemptId],
      foreignColumns: [publicationAttempts.workspaceId, publicationAttempts.id],
      name: 'x_remediation_journals_source_attempt_fk',
    }).onDelete('restrict'),
  ],
);

export const publicationJobEvents = pgTable(
  'publication_job_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').notNull(),
    fromState: publicationJobState('from_state'),
    toState: publicationJobState('to_state').notNull(),
    reason: text('reason').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('publication_job_events_job_created_idx').on(table.jobId, table.createdAt),
    foreignKey({
      columns: [table.workspaceId, table.jobId],
      foreignColumns: [publicationJobs.workspaceId, publicationJobs.id],
      name: 'publication_job_events_workspace_job_fk',
    }).onDelete('cascade'),
  ],
);

export const providerStagingArtifacts = pgTable(
  'provider_staging_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').notNull(),
    mediaId: uuid('media_id'),
    artifactKey: text('artifact_key')
      .notNull()
      .default(sql`'legacy:' || gen_random_uuid()::text`),
    artifactKind: text('artifact_kind').notNull().default('legacy'),
    artifactStatus: text('artifact_status').notNull().default('initialized'),
    redactedEvidence: jsonb('redacted_evidence').notNull().default({}),
    providerReference: text('provider_reference').notNull(),
    providerReferenceCredentialId: uuid('provider_reference_credential_id'),
    uploadPhase: text('upload_phase').notNull().default('initialized'),
    nextSegment: integer('next_segment').notNull().default(0),
    nextByteOffset: bigint('next_byte_offset', { mode: 'number' }).notNull().default(0),
    externalObjectId: text('external_object_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('provider_staging_job_media_unique')
      .on(table.workspaceId, table.jobId, table.mediaId)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex('provider_staging_job_artifact_key_unique').on(
      table.workspaceId,
      table.jobId,
      table.artifactKey,
    ),
    index('provider_staging_expiry_idx').on(table.workspaceId, table.expiresAt),
    foreignKey({
      columns: [table.workspaceId, table.jobId],
      foreignColumns: [publicationJobs.workspaceId, publicationJobs.id],
      name: 'provider_staging_workspace_job_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.mediaId],
      foreignColumns: [mediaObjects.workspaceId, mediaObjects.id],
      name: 'provider_staging_workspace_media_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.providerReferenceCredentialId],
      foreignColumns: [credentials.workspaceId, credentials.id],
      name: 'provider_staging_workspace_reference_credential_fk',
    }).onDelete('restrict'),
  ],
);

export const fanvueActionIntents = pgTable(
  'fanvue_action_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    clientActionId: uuid('client_action_id').notNull(),
    actionKind: text('action_kind').notNull(),
    targetUuid: uuid('target_uuid').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    state: text('state').notNull().default('reserved'),
    textBody: text('text_body'),
    targetLabel: text('target_label'),
    mediaCount: integer('media_count'),
    priceCents: integer('price_cents'),
    providerObjectUuid: uuid('provider_object_uuid'),
    failureStatus: integer('failure_status'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('fanvue_action_intents_action_unique').on(
      table.workspaceId,
      table.accountId,
      table.clientActionId,
    ),
    index('fanvue_action_intents_account_created_idx').on(
      table.workspaceId,
      table.accountId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'fanvue_action_intents_workspace_account_fk',
    }).onDelete('restrict'),
  ],
);

export const fanvueVaultMediaPrices = pgTable(
  'fanvue_vault_media_prices',
  {
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    providerMediaUuid: uuid('provider_media_uuid').notNull(),
    manualPriceCents: integer('manual_price_cents'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.accountId, table.providerMediaUuid] }),
    check(
      'fanvue_vault_media_prices_positive_price_check',
      sql`${table.manualPriceCents} is null or ${table.manualPriceCents} > 0`,
    ),
    check('fanvue_vault_media_prices_positive_version_check', sql`${table.version} > 0`),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'fanvue_vault_media_prices_account_fk',
    }).onDelete('restrict'),
  ],
);

export const fanvueDmPendingIntents = pgTable(
  'fanvue_dm_pending_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    fanUuid: uuid('fan_uuid').notNull(),
    clientActionId: uuid('client_action_id').notNull(),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    textBody: text('text_body'),
    targetLabel: text('target_label'),
    mediaIds: jsonb('media_ids').$type<string[]>().notNull().default([]),
    mediaPreviewId: uuid('media_preview_id'),
    priceCents: integer('price_cents'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    groupId: uuid('group_id'),
    sequenceIndex: integer('sequence_index'),
    gapSeconds: integer('gap_seconds'),
    expectedLatestInboundMessageUuid: uuid('expected_latest_inbound_message_uuid'),
    expectedLatestInboundAt: timestamp('expected_latest_inbound_at', { withTimezone: true }),
    requestFingerprint: text('request_fingerprint'),
    status: text('status').notNull().default('pending'),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('fanvue_dm_pending_intents_action_unique').on(
      table.workspaceId,
      table.clientActionId,
    ),
    index('fanvue_dm_pending_intents_due_idx').on(table.dueAt, table.id),
    uniqueIndex('fanvue_dm_pending_intents_group_sequence_unique')
      .on(table.workspaceId, table.groupId, table.sequenceIndex)
      .where(sql`${table.groupId} is not null`),
    check(
      'fanvue_dm_pending_intents_group_shape_check',
      sql`(${table.groupId} is null and ${table.sequenceIndex} is null and ${table.gapSeconds} is null and ${table.expectedLatestInboundMessageUuid} is null and ${table.expectedLatestInboundAt} is null and ${table.requestFingerprint} is null) or (${table.groupId} is not null and ${table.sequenceIndex} between 0 and 4 and ${table.gapSeconds} between 0 and 10 and (${table.sequenceIndex} <> 0 or ${table.gapSeconds} = 0) and ${table.expectedLatestInboundMessageUuid} is not null and ${table.expectedLatestInboundAt} is not null and ${table.requestFingerprint} is not null)`,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'fanvue_dm_pending_intents_account_fk',
    }).onDelete('restrict'),
  ],
);

export const fanvueDmConversationState = pgTable(
  'fanvue_dm_conversation_state',
  {
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    fanUuid: uuid('fan_uuid').notNull(),
    latestObservedMessageUuid: uuid('latest_observed_message_uuid'),
    latestObservedAt: timestamp('latest_observed_at', { withTimezone: true }),
    latestObservedDirection: text('latest_observed_direction'),
    latestInboundMessageUuid: uuid('latest_inbound_message_uuid'),
    latestInboundAt: timestamp('latest_inbound_at', { withTimezone: true }),
    latestOutboundMessageUuid: uuid('latest_outbound_message_uuid'),
    latestOutboundAt: timestamp('latest_outbound_at', { withTimezone: true }),
    lastProcessedInboundUuid: uuid('last_processed_inbound_uuid'),
    lastProcessedInboundAt: timestamp('last_processed_inbound_at', { withTimezone: true }),
    providerIsRead: boolean('provider_is_read'),
    providerUnreadCount: integer('provider_unread_count'),
    lastChatListSeenAt: timestamp('last_chat_list_seen_at', { withTimezone: true }),
    logicalExchangeCount: integer('logical_exchange_count').notNull().default(0),
    activeDayCount: integer('active_day_count').notNull().default(0),
    nextReviewAt: timestamp('next_review_at', { withTimezone: true }),
    quietUntilInboundAfterUuid: uuid('quiet_until_inbound_after_uuid'),
    historyCoverageOldestAt: timestamp('history_coverage_oldest_at', { withTimezone: true }),
    historyBackfillCompleteAt: timestamp('history_backfill_complete_at', { withTimezone: true }),
    historyBackfillStatus: text('history_backfill_status').notNull().default('not_started'),
    historyBackfillFailureCode: text('history_backfill_failure_code'),
    historyBackfillLastAttemptAt: timestamp('history_backfill_last_attempt_at', {
      withTimezone: true,
    }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.accountId, table.fanUuid] }),
    index('fanvue_dm_conversation_state_due_idx').on(
      table.workspaceId,
      table.accountId,
      table.nextReviewAt,
    ),
    check(
      'fanvue_dm_conversation_state_direction_check',
      sql`${table.latestObservedDirection} is null or ${table.latestObservedDirection} in ('inbound', 'outbound')`,
    ),
    check(
      'fanvue_dm_conversation_state_counts_check',
      sql`${table.logicalExchangeCount} >= 0 and ${table.activeDayCount} >= 0 and (${table.providerUnreadCount} is null or ${table.providerUnreadCount} >= 0)`,
    ),
    check(
      'fanvue_dm_conversation_state_history_status_check',
      sql`${table.historyBackfillStatus} in ('not_started', 'in_progress', 'incomplete', 'complete')`,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'fanvue_dm_conversation_state_account_fk',
    }).onDelete('restrict'),
  ],
);

export const fanvueDmMessageReceipts = pgTable(
  'fanvue_dm_message_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    fanUuid: uuid('fan_uuid').notNull(),
    providerMessageUuid: uuid('provider_message_uuid').notNull(),
    direction: text('direction').notNull(),
    exchangeRole: text('exchange_role').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    mediaUuids: jsonb('media_uuids').$type<string[]>().notNull().default([]),
    priceCents: integer('price_cents'),
    purchasedAt: timestamp('purchased_at', { withTimezone: true }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('fanvue_dm_message_receipts_provider_unique').on(
      table.workspaceId,
      table.accountId,
      table.providerMessageUuid,
    ),
    index('fanvue_dm_message_receipts_fan_sent_idx').on(
      table.workspaceId,
      table.accountId,
      table.fanUuid,
      table.sentAt,
    ),
    check(
      'fanvue_dm_message_receipts_direction_check',
      sql`${table.direction} in ('inbound', 'outbound')`,
    ),
    check(
      'fanvue_dm_message_receipts_exchange_role_check',
      sql`(${table.direction} = 'inbound' and ${table.exchangeRole} = 'inbound_turn') or (${table.direction} = 'outbound' and ${table.exchangeRole} in ('outbound_root', 'outbound_tail', 'automation'))`,
    ),
    check(
      'fanvue_dm_message_receipts_price_check',
      sql`${table.priceCents} is null or ${table.priceCents} >= 0`,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'fanvue_dm_message_receipts_account_fk',
    }).onDelete('restrict'),
  ],
);

export const fanvueDmConversationCheckpoints = pgTable(
  'fanvue_dm_conversation_checkpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    fanUuid: uuid('fan_uuid').notNull(),
    kind: text('kind').notNull(),
    ordinal: integer('ordinal').notNull(),
    clientActionId: uuid('client_action_id').notNull(),
    groupId: uuid('group_id'),
    state: text('state').notNull(),
    providerMessageUuid: uuid('provider_message_uuid'),
    providerMediaUuid: uuid('provider_media_uuid'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('fanvue_dm_conversation_checkpoints_kind_unique').on(
      table.workspaceId,
      table.accountId,
      table.fanUuid,
      table.kind,
      table.ordinal,
    ),
    uniqueIndex('fanvue_dm_conversation_checkpoints_action_unique').on(
      table.workspaceId,
      table.accountId,
      table.clientActionId,
    ),
    check(
      'fanvue_dm_conversation_checkpoints_kind_check',
      sql`${table.kind} in ('welcome', 'silent_followup', 'free_gift', 'paid_offer')`,
    ),
    check(
      'fanvue_dm_conversation_checkpoints_state_check',
      sql`${table.state} in ('pending', 'confirmed', 'unknown', 'cancelled')`,
    ),
    check('fanvue_dm_conversation_checkpoints_ordinal_check', sql`${table.ordinal} > 0`),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'fanvue_dm_conversation_checkpoints_account_fk',
    }).onDelete('restrict'),
  ],
);

export const fanvueDmMediaDeliveries = pgTable(
  'fanvue_dm_media_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    fanUuid: uuid('fan_uuid').notNull(),
    providerMediaUuid: uuid('provider_media_uuid').notNull(),
    source: text('source').notNull(),
    clientActionId: uuid('client_action_id'),
    providerMessageUuid: uuid('provider_message_uuid'),
    state: text('state').notNull(),
    priceCents: integer('price_cents'),
    purchasedAt: timestamp('purchased_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('fanvue_dm_media_deliveries_active_unique')
      .on(table.workspaceId, table.accountId, table.fanUuid, table.providerMediaUuid)
      .where(sql`${table.state} in ('reserved', 'confirmed', 'unknown')`),
    index('fanvue_dm_media_deliveries_fan_idx').on(
      table.workspaceId,
      table.accountId,
      table.fanUuid,
      table.createdAt,
    ),
    check(
      'fanvue_dm_media_deliveries_source_check',
      sql`${table.source} in ('relay_action', 'provider_history')`,
    ),
    check(
      'fanvue_dm_media_deliveries_state_check',
      sql`${table.state} in ('reserved', 'confirmed', 'unknown', 'cancelled')`,
    ),
    check(
      'fanvue_dm_media_deliveries_price_check',
      sql`${table.priceCents} is null or ${table.priceCents} >= 0`,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'fanvue_dm_media_deliveries_account_fk',
    }).onDelete('restrict'),
  ],
);

export const fanvueDmDispatchPacing = pgTable(
  'fanvue_dm_dispatch_pacing',
  {
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    nextAt: timestamp('next_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.accountId] }),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
    }).onDelete('cascade'),
  ],
);

export const fanvueCommentPendingIntents = pgTable(
  'fanvue_comment_pending_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    postUuid: uuid('post_uuid').notNull(),
    clientActionId: uuid('client_action_id').notNull(),
    actorType: actorType('actor_type').notNull(),
    actorId: uuid('actor_id').notNull(),
    textBody: text('text_body').notNull(),
    targetLabel: text('target_label'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('pending'),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('fanvue_comment_pending_intents_action_unique').on(
      table.workspaceId,
      table.clientActionId,
    ),
    index('fanvue_comment_pending_intents_due_idx').on(table.dueAt, table.id),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'fanvue_comment_pending_intents_account_fk',
    }).onDelete('restrict'),
  ],
);

export const fanvueDmAttachments = pgTable(
  'fanvue_dm_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    clientActionId: uuid('client_action_id').notNull(),
    mediaId: uuid('media_id').notNull(),
    state: text('state').notNull().default('bound'),
    providerMediaUuid: uuid('provider_media_uuid'),
    uploadCredentialId: uuid('upload_credential_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('fanvue_dm_attachments_action_media_unique').on(
      table.workspaceId,
      table.accountId,
      table.clientActionId,
      table.mediaId,
    ),
    index('fanvue_dm_attachments_media_active_idx')
      .on(table.workspaceId, table.mediaId)
      .where(sql`${table.state} <> 'released'`),
    check(
      'fanvue_dm_attachments_state_check',
      sql`${table.state} in ('bound', 'uploading', 'unknown', 'ready', 'failed', 'released')`,
    ),
    check(
      'fanvue_dm_attachments_ready_check',
      sql`${table.state} <> 'ready' or ${table.providerMediaUuid} is not null`,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'fanvue_dm_attachments_account_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.mediaId],
      foreignColumns: [mediaObjects.workspaceId, mediaObjects.id],
      name: 'fanvue_dm_attachments_media_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.uploadCredentialId],
      foreignColumns: [credentials.workspaceId, credentials.id],
      name: 'fanvue_dm_attachments_upload_credential_fk',
    }).onDelete('restrict'),
  ],
);

export const fanvuePaymentReceipts = pgTable(
  'fanvue_payment_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    eventId: uuid('event_id').notNull(),
    eventFingerprint: text('event_fingerprint').notNull(),
    creatorUuid: uuid('creator_uuid').notNull(),
    fanUuid: uuid('fan_uuid').notNull(),
    invoiceId: text('invoice_id').notNull(),
    source: text('source').notNull(),
    grossMinor: integer('gross_minor').notNull(),
    currency: text('currency'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
    postUuid: uuid('post_uuid'),
    messageUuid: uuid('message_uuid'),
    tipContext: text('tip_context'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('fanvue_payment_receipts_event_unique').on(
      table.workspaceId,
      table.accountId,
      table.eventId,
    ),
    index('fanvue_payment_receipts_account_paid_idx').on(
      table.workspaceId,
      table.accountId,
      table.eventAt,
      table.id,
    ),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'fanvue_payment_receipts_account_fk',
    }).onDelete('restrict'),
  ],
);

export const fanvuePaymentSubscriptions = pgTable(
  'fanvue_payment_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    creatorUuid: uuid('creator_uuid').notNull(),
    callbackHandleHash: text('callback_handle_hash').notNull(),
    providerSubscriptionId: text('provider_subscription_id'),
    signingCredentialId: uuid('signing_credential_id'),
    state: text('state').notNull().default('probe_pending'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('fanvue_payment_subscriptions_handle_unique').on(table.callbackHandleHash),
    uniqueIndex('fanvue_payment_subscriptions_account_open_unique')
      .on(table.workspaceId, table.accountId)
      .where(sql`${table.state} <> 'disabled'`),
    foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'fanvue_payment_subscriptions_account_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.signingCredentialId],
      foreignColumns: [credentials.workspaceId, credentials.id],
      name: 'fanvue_payment_subscriptions_signing_credential_fk',
    }).onDelete('restrict'),
  ],
);
