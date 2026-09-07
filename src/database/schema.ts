import {
  bigint,
  boolean,
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
export const actorType = pgEnum('audit_actor_type', ['user', 'api_key', 'system']);
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
  ...timestamps,
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
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
    uniqueIndex('api_keys_workspace_id_unique').on(table.workspaceId, table.id),
    index('api_keys_workspace_idx').on(table.workspaceId),
  ],
);

export const apiMutationResults = pgTable(
  'api_mutation_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id').notNull(),
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
      table.apiKeyId,
      table.operation,
      table.idempotencyKey,
    ),
    index('api_mutation_results_workspace_created_idx').on(table.workspaceId, table.createdAt),
    foreignKey({
      columns: [table.workspaceId, table.apiKeyId],
      foreignColumns: [apiKeys.workspaceId, apiKeys.id],
      name: 'api_mutation_results_workspace_api_key_fk',
    }).onDelete('cascade'),
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
  (table) => [
    index('provider_connections_workspace_idx').on(table.workspaceId),
    uniqueIndex('provider_connections_workspace_provider_unique').on(
      table.workspaceId,
      table.provider,
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
    displayName: text('display_name').notNull(),
    adapterDefaults: jsonb('adapter_defaults').notNull().default({}),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('provider_accounts_workspace_id_unique').on(table.workspaceId, table.id),
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
    effectiveProviderSettings: jsonb('effective_provider_settings'),
    state: publicationJobState('state').notNull().default('scheduled'),
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
      foreignColumns: [providerAccounts.workspaceId, providerAccounts.id],
      name: 'publication_jobs_workspace_provider_account_fk',
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
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    outcome: publicationAttemptOutcome('outcome'),
    providerRequestId: text('provider_request_id'),
    externalPostId: text('external_post_id'),
    reconciliationKey: text('reconciliation_key'),
    retryAt: timestamp('retry_at', { withTimezone: true }),
    redactedError: text('redacted_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('publication_attempts_workspace_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('publication_attempts_job_number_unique').on(table.jobId, table.attemptNumber),
    index('publication_attempts_idempotency_idx').on(table.workspaceId, table.idempotencyKey),
    index('publication_attempts_reconciliation_idx').on(table.workspaceId, table.reconciliationKey),
    foreignKey({
      columns: [table.workspaceId, table.jobId],
      foreignColumns: [publicationJobs.workspaceId, publicationJobs.id],
      name: 'publication_attempts_workspace_job_fk',
    }).onDelete('cascade'),
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
    mediaId: uuid('media_id').notNull(),
    providerReference: text('provider_reference').notNull(),
    uploadPhase: text('upload_phase').notNull().default('initialized'),
    nextSegment: integer('next_segment').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('provider_staging_job_media_unique')
      .on(table.workspaceId, table.jobId, table.mediaId)
      .where(sql`${table.deletedAt} is null`),
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
  ],
);
