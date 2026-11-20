#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
const EXIT = {
  usage: 2,
  auth: 3,
  authorization: 4,
  validation: 5,
  conflict: 6,
  rate: 7,
  transient: 8,
  terminal: 9,
  timeout: 10,
};
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MUTATIONS = new Set([
  'drafts:create',
  'posts:create',
  'media:upload',
  'publishes:retry',
  'fanvue-guidance:set',
  'facebook-guidance:set',
  'fanvue:create-chat',
  'fanvue-dms:group-schedule',
  'fanvue-dms:group-cancel',
  'fanvue-dms:history-backfill',
  'facebook-comments:reply',
  'facebook-comments:schedule',
  'facebook-comments:cancel',
  'facebook-dms:send',
  'facebook-dms:schedule',
  'facebook-dms:group-schedule',
  'facebook-dms:group-cancel',
  'facebook-dms:cancel',
  'facebook-dms:memory-upsert',
  'proposals:create',
]);
const ROUTES = {
  'account:current': { method: 'GET', path: '/api/v1/account' },
  'proposals:create': { method: 'POST', path: '/api/v1/engagement-proposals', body: true },
  'proposals:status': { method: 'GET', path: '/api/v1/engagement-proposals/:id/status' },
  'destinations:list': { method: 'GET', path: '/api/v1/destinations' },
  'facebook-comments:posts': { method: 'GET', path: '/api/v1/destinations/:id/facebook-posts' },
  'facebook-comments:list': {
    method: 'GET',
    path: '/api/v1/destinations/:id/facebook-posts/:postId/comments',
  },
  'facebook-comments:reply': {
    method: 'POST',
    path: '/api/v1/destinations/:id/facebook-posts/:postId/comments/:commentId/replies',
    body: true,
  },
  'facebook-comments:schedule': {
    method: 'POST',
    path: '/api/v1/destinations/:id/facebook-posts/:postId/comments/:commentId/replies/schedule',
    body: true,
  },
  'facebook-comments:status': {
    method: 'GET',
    path: '/api/v1/destinations/:id/facebook-comment-replies/:intentId',
  },
  'facebook-comments:cancel': {
    method: 'DELETE',
    path: '/api/v1/destinations/:id/facebook-comment-replies/:intentId',
  },
  'facebook-dms:list': { method: 'GET', path: '/api/v1/destinations/:id/facebook-conversations' },
  'facebook-dms:messages': {
    method: 'GET',
    path: '/api/v1/destinations/:id/facebook-conversations/:conversationId/messages',
  },
  'facebook-dms:send': {
    method: 'POST',
    path: '/api/v1/destinations/:id/facebook-conversations/:conversationId/messages',
    body: true,
  },
  'facebook-dms:schedule': {
    method: 'POST',
    path: '/api/v1/destinations/:id/facebook-conversations/:conversationId/messages',
    body: true,
  },
  'facebook-dms:cancel': {
    method: 'DELETE',
    path: '/api/v1/destinations/:id/facebook-conversations/:conversationId/scheduled/:intentId',
  },
  'facebook-dms:group-schedule': {
    method: 'POST',
    path: '/api/v1/destinations/:id/facebook-conversations/:conversationId/scheduled-groups',
    body: true,
  },
  'facebook-dms:group-status': {
    method: 'GET',
    path: '/api/v1/destinations/:id/facebook-conversations/:conversationId/scheduled-groups/:rootId',
  },
  'facebook-dms:group-cancel': {
    method: 'DELETE',
    path: '/api/v1/destinations/:id/facebook-conversations/:conversationId/scheduled-groups/:rootId',
  },
  'facebook-dms:memory-get-many': {
    method: 'POST',
    path: '/api/v1/destinations/:id/facebook-conversations/memory/get-many',
    body: true,
  },
  'facebook-dms:memory-upsert': {
    method: 'PATCH',
    path: '/api/v1/destinations/:id/facebook-conversations/:conversationId/memory',
    body: true,
  },
  'fanvue:followers': { method: 'GET', path: '/api/v1/fanvue/accounts/:id/followers' },
  'fanvue:subscribers': { method: 'GET', path: '/api/v1/fanvue/accounts/:id/subscribers' },
  'fanvue:folders': { method: 'GET', path: '/api/v1/fanvue/accounts/:id/vault/folders' },
  'fanvue:folder-media': {
    method: 'GET',
    path: '/api/v1/fanvue/accounts/:id/vault/folders/:folderName/media',
  },
  'fanvue:vault-catalog': {
    method: 'GET',
    path: '/api/v1/fanvue/accounts/:id/vault/catalog/:folderName',
  },
  'fanvue:vault-price-set': {
    method: 'PATCH',
    path: '/api/v1/fanvue/accounts/:id/vault/media/:mediaUuid/price',
    body: true,
  },
  'fanvue:vault-purchase-fact': {
    method: 'GET',
    path: '/api/v1/fanvue/accounts/:id/vault/media/:mediaUuid/purchase',
  },
  'fanvue:vault-publication-fact': {
    method: 'GET',
    path: '/api/v1/fanvue/accounts/:id/vault/media/:mediaUuid/publication',
  },
  'fanvue-guidance:show': { method: 'GET', path: '/api/v1/fanvue/accounts/:id/guidance' },
  'fanvue-guidance:set': {
    method: 'PATCH',
    path: '/api/v1/fanvue/accounts/:id/guidance',
    body: true,
  },
  'facebook-guidance:show': { method: 'GET', path: '/api/v1/facebook-pages/:id/guidance' },
  'facebook-guidance:set': {
    method: 'PATCH',
    path: '/api/v1/facebook-pages/:id/guidance',
    body: true,
  },
  'fanvue:create-chat': {
    method: 'POST',
    path: '/api/v1/fanvue/accounts/:id/chats',
    body: true,
  },
  'fanvue-dms:group-schedule': {
    method: 'POST',
    path: '/api/v1/fanvue/accounts/:id/chats/:fanUuid/messages/scheduled-groups',
    body: true,
  },
  'fanvue-dms:group-status': {
    method: 'GET',
    path: '/api/v1/fanvue/accounts/:id/chats/:fanUuid/messages/scheduled-groups/:rootId',
  },
  'fanvue-dms:group-cancel': {
    method: 'DELETE',
    path: '/api/v1/fanvue/accounts/:id/chats/:fanUuid/messages/scheduled-groups/:rootId',
  },
  'fanvue-dms:candidates': {
    method: 'GET',
    path: '/api/v1/fanvue/accounts/:id/dm-conversations/due',
  },
  'fanvue-dms:checkpoints': {
    method: 'GET',
    path: '/api/v1/fanvue/accounts/:id/chats/:fanUuid/checkpoints',
  },
  'fanvue-dms:history-backfill': {
    method: 'POST',
    path: '/api/v1/fanvue/accounts/:id/chats/:fanUuid/history-backfill',
    body: true,
  },
  'drafts:create': { method: 'POST', path: '/api/v1/drafts', body: true },
  'drafts:show': { method: 'GET', path: '/api/v1/drafts/:id' },
  'posts:create': { method: 'POST', path: '/api/v1/posts', body: true },
  'posts:validate': { method: 'POST', path: '/api/v1/posts/validate', body: true },
  'posts:list': { method: 'GET', path: '/api/v1/posts' },
  'posts:show': { method: 'GET', path: '/api/v1/posts/:id' },
  'publishes:list': { method: 'GET', path: '/api/v1/jobs' },
  'media:upload': { method: 'POST', path: '/api/v1/media' },
  'publishes:show': { method: 'GET', path: '/api/v1/jobs/:id' },
  'publishes:poll': { method: 'GET', path: '/api/v1/jobs/:id' },
  'publishes:retry': { method: 'POST', path: '/api/v1/jobs/:id/retry' },
  health: { method: 'GET', path: '/health/live' },
};
const ENVELOPE_OUTPUT_KEYS = [
  'success',
  'data',
  'error',
  'meta',
  'code',
  'message',
  'requestId',
  'details',
  'id',
  'postId',
  'revisionId',
  'jobId',
  'workspaceId',
  'workspaceLabel',
  'state',
  'status',
  'links',
  'post',
  'job',
  'next',
  'cursor',
  'version',
];
const SAFE_OUTPUT_KEYS_BY_COMMAND = {
  'proposals:status': new Set([...ENVELOPE_OUTPUT_KEYS, 'plannedDueAt']),
  'facebook-comments:posts': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'posts',
    'nextCursor',
    'text',
    'createdAt',
    'permalink',
  ]),
  'facebook-comments:list': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'comments',
    'nextCursor',
    'text',
    'createdAt',
    'replyCount',
    'likeCount',
  ]),
  'facebook-dms:list': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'conversations',
    'nextCursor',
    'updatedAt',
    'displayName',
    'noGo',
    'terminal',
    'link',
  ]),
  'facebook-dms:messages': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'participantId',
    'displayName',
    'link',
    'messages',
    'nextCursor',
    'text',
    'createdAt',
    'senderId',
    'contentKind',
    'contentSubtype',
  ]),
  'facebook-comments:reply': new Set([...ENVELOPE_OUTPUT_KEYS, 'commentId', 'failureStatus']),
  'facebook-comments:schedule': new Set([...ENVELOPE_OUTPUT_KEYS, 'dueAt']),
  'facebook-comments:status': new Set([...ENVELOPE_OUTPUT_KEYS, 'dueAt']),
  'facebook-comments:cancel': new Set(ENVELOPE_OUTPUT_KEYS),
  'facebook-dms:send': new Set([...ENVELOPE_OUTPUT_KEYS, 'messageId', 'failureStatus']),
  'facebook-dms:schedule': new Set([...ENVELOPE_OUTPUT_KEYS, 'dueAt']),
  'facebook-dms:cancel': new Set(ENVELOPE_OUTPUT_KEYS),
  'facebook-dms:group-schedule': new Set([...ENVELOPE_OUTPUT_KEYS, 'dueAt']),
  'facebook-dms:group-status': new Set([...ENVELOPE_OUTPUT_KEYS, 'bubbles', 'sequence', 'dueAt']),
  'facebook-dms:group-cancel': new Set([...ENVELOPE_OUTPUT_KEYS, 'cancelled']),
  'facebook-dms:memory-get-many': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'records',
    'conversationId',
    'facts',
    'firstContactAt',
    'conversationAgeDays',
    'activeDayStreak',
    'lastActiveDay',
    'bioLinkMentionAt',
    'bioLinkActionId',
    'bioLinkMessageId',
    'lastProcessedInboundId',
    'lastOutboundReceiptRef',
    'terminal',
    'unansweredFollowUp',
  ]),
  'facebook-dms:memory-upsert': new Set([...ENVELOPE_OUTPUT_KEYS, 'conversationId']),
  'fanvue:followers': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'pagination',
    'page',
    'size',
    'hasMore',
    'uuid',
    'handle',
    'displayName',
    'relationship',
    'subscriptionStatus',
  ]),
  'fanvue:subscribers': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'pagination',
    'page',
    'size',
    'hasMore',
    'nextCursor',
    'uuid',
    'handle',
    'displayName',
    'relationship',
    'subscriptionStatus',
  ]),
  'fanvue:folders': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'pagination',
    'page',
    'size',
    'hasMore',
    'name',
    'createdAt',
    'mediaCount',
  ]),
  'fanvue:folder-media': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'pagination',
    'page',
    'size',
    'hasMore',
    'uuid',
    'status',
    'name',
    'mediaType',
  ]),
  'fanvue:vault-catalog': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'pagination',
    'page',
    'size',
    'hasMore',
    'uuid',
    'status',
    'name',
    'mediaType',
    'manualPriceCents',
    'priceVersion',
  ]),
  'fanvue:vault-price-set': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'providerMediaUuid',
    'manualPriceCents',
    'version',
    'updatedAt',
  ]),
  'fanvue:vault-purchase-fact': new Set([...ENVELOPE_OUTPUT_KEYS, 'state', 'purchasedByFan']),
  'fanvue:vault-publication-fact': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'state',
    'scannedAt',
    'pagesScanned',
    'uniquePostsScanned',
    'complete',
    'incompleteReason',
    'matchingPostUuid',
    'publishedAt',
  ]),
  'fanvue-guidance:show': new Set([...ENVELOPE_OUTPUT_KEYS, 'guidance']),
  'fanvue-guidance:set': new Set([...ENVELOPE_OUTPUT_KEYS, 'guidance']),
  'facebook-guidance:show': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'profile',
    'dmGuidance',
    'commentGuidance',
  ]),
  'facebook-guidance:set': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'profile',
    'dmGuidance',
    'commentGuidance',
  ]),
  'fanvue:create-chat': new Set([...ENVELOPE_OUTPUT_KEYS, 'fanUuid', 'failureStatus']),
  'fanvue-dms:group-schedule': new Set([...ENVELOPE_OUTPUT_KEYS, 'dueAt']),
  'fanvue-dms:group-status': new Set([...ENVELOPE_OUTPUT_KEYS, 'bubbles', 'sequence', 'dueAt']),
  'fanvue-dms:history-backfill': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'state',
    'reason',
    'pagesIngested',
    'messagesIngested',
    'oldestAt',
  ]),
  'fanvue-dms:group-cancel': new Set([...ENVELOPE_OUTPUT_KEYS, 'cancelled']),
  'fanvue-dms:candidates': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'fanUuid',
    'latestObservedMessageUuid',
    'latestObservedAt',
    'latestInboundMessageUuid',
    'latestInboundAt',
    'providerIsRead',
    'providerUnreadCount',
    'nextReviewAt',
    'historyBackfillCompleteAt',
  ]),
  'fanvue-dms:checkpoints': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'kind',
    'ordinal',
    'providerMessageUuid',
    'providerMediaUuid',
  ]),
  'account:current': new Set([...ENVELOPE_OUTPUT_KEYS, 'prefix', 'capabilities', 'expiresAt']),
  'destinations:list': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'items',
    'nextCursor',
    'provider',
    'destinationProvider',
    'displayName',
    'availability',
    'remoteParentAccountId',
    'capabilitySnapshot',
    'schemaVersion',
    'capabilitiesCheckedAt',
    'capabilityFreshness',
    'contentKinds',
    'media',
    'minImages',
    'maxImages',
    'updatedAt',
  ]),
  'drafts:create': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'externalId',
    'label',
    'returnUrl',
    'mediaIds',
    'postId',
    'createdAt',
    'self',
    'cockpit',
  ]),
  'drafts:show': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'externalId',
    'label',
    'returnUrl',
    'mediaIds',
    'postId',
    'createdAt',
    'self',
    'cockpit',
  ]),
  'posts:create': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'self',
    'jobs',
    'mediaCount',
    'previewMediaId',
    'effectiveProviderSettings',
    'effectivePayload',
    'destinationProvider',
    'kind',
    'caption',
    'message',
    'linkUrl',
    'mediaIds',
    'schemaVersion',
    'title',
    'description',
    'privacyStatus',
    'madeForKids',
    'notifySubscribers',
    'tags',
    'categoryId',
  ]),
  'posts:validate': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'valid',
    'mediaNotValidated',
    'destinations',
    'providerAccountId',
    'weightedLength',
    'limit',
  ]),
  'posts:list': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'items',
    'nextCursor',
    'createdAt',
    'updatedAt',
    'self',
  ]),
  'posts:show': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'createdAt',
    'updatedAt',
    'revisionNumber',
    'scheduledAt',
    'jobs',
    'approvalRequired',
    'approvalStatus',
    'self',
  ]),
  'publishes:list': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'items',
    'nextCursor',
    'scheduledAt',
    'updatedAt',
    'destination',
    'approvalRequired',
    'approvalStatus',
    'displayName',
    'provider',
    'self',
  ]),
  'media:upload': new Set([...ENVELOPE_OUTPUT_KEYS, 'mimeType', 'sha256', 'byteSize']),
  'publishes:show': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'createdAt',
    'updatedAt',
    'scheduledAt',
    'approvalRequired',
    'approvalStatus',
    'approvedAt',
    'self',
    'revisionId',
    'content',
    'text',
    'media',
    'position',
    'mimeType',
    'byteSize',
    'sha256',
    'previewUrl',
    'attempts',
    'attemptNumber',
    'startedAt',
    'finishedAt',
    'outcome',
    'externalPostId',
    'retryAt',
    'activity',
    'fromState',
    'toState',
    'reason',
    'providerResult',
    'url',
    'creator',
    'lastMutator',
    'type',
    'label',
    'providerAccount',
    'displayName',
    'originWorkspaceName',
    'handle',
    'provider',
    'mediaCount',
    'previewMediaId',
    'effectiveProviderSettings',
    'effectivePayload',
    'destinationProvider',
    'kind',
    'caption',
    'message',
    'linkUrl',
    'mediaIds',
    'schemaVersion',
    'title',
    'description',
    'privacyStatus',
    'madeForKids',
    'notifySubscribers',
    'tags',
    'categoryId',
  ]),
  'publishes:poll': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'createdAt',
    'updatedAt',
    'scheduledAt',
    'approvalRequired',
    'approvalStatus',
    'approvedAt',
    'self',
    'mediaCount',
    'previewMediaId',
    'effectiveProviderSettings',
    'effectivePayload',
    'destinationProvider',
    'kind',
    'caption',
    'message',
    'linkUrl',
    'mediaIds',
    'schemaVersion',
    'title',
    'description',
    'privacyStatus',
    'madeForKids',
    'notifySubscribers',
    'tags',
    'categoryId',
  ]),
  'publishes:retry': new Set([...ENVELOPE_OUTPUT_KEYS, 'self']),
};
const DEFAULT_OUTPUT_KEYS = new Set(ENVELOPE_OUTPUT_KEYS);
const REDACTED = '[REDACTED]';
let activeCommand = 'error';
class CliError extends Error {
  exitCode;
  data;
  constructor(exitCode, message, data) {
    super(message);
    this.exitCode = exitCode;
    this.data = data;
  }
}
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (!value.startsWith('--')) positional.push(value);
    else {
      const name = value.slice(2);
      if (/(api.?key|secret|token|password)/i.test(name))
        throw new CliError(EXIT.usage, `--${name} is forbidden; load secrets from the environment`);
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) flags[name] = true;
      else {
        flags[name] = next;
        index += 1;
      }
    }
  }
  if (positional[0] === 'version') return { command: 'version', flags };
  if (positional[0] === 'health') return { command: 'health', flags };
  if (!positional[0] || !positional[1])
    throw new CliError(EXIT.usage, 'Expected a noun and action');
  const id = positional[2];
  return { command: `${positional[0]}:${positional[1]}`, ...(id ? { id } : {}), flags };
}
function rejectSecrets(value, path = 'profile') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(secret|token|password|api.?key(?!Env))/i.test(key))
      throw new CliError(EXIT.usage, `${path}.${key} may not contain secret material`);
    rejectSecrets(child, `${path}.${key}`);
  }
}
async function loadEnvironment(path) {
  if (!path || path === true) return {};
  const result = {};
  for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined)
      result[name] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}
async function loadProfile(path) {
  if (!path || path === true) return { baseUrl: process.env.PUBLISH_RELAY_BASE_URL ?? '' };
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  rejectSecrets(parsed);
  if (!parsed || typeof parsed !== 'object')
    throw new CliError(EXIT.usage, 'Profile must be a JSON object');
  return parsed;
}
function mapExit(status, code) {
  if (status === 401) return EXIT.auth;
  if (status === 403 || code === 'workspace_mismatch') return EXIT.authorization;
  if (status === 400 || status === 404 || status === 422) return EXIT.validation;
  if (status === 409) return EXIT.conflict;
  if (status === 429) return EXIT.rate;
  if (status >= 500) return EXIT.transient;
  return EXIT.terminal;
}
async function request(profile, key, workspace, path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, profile.timeoutMs ?? 30_000);
  try {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${key}`);
    headers.set('accept', 'application/json');
    if (workspace) headers.set('x-publish-relay-workspace', workspace);
    const response = await fetch(new URL(path, profile.baseUrl), {
      ...init,
      signal: controller.signal,
      headers,
    });
    const body = await response.json();
    return { status: response.status, body };
  } catch (error) {
    throw new CliError(
      EXIT.transient,
      error instanceof Error ? error.message : 'Network request failed',
    );
  } finally {
    clearTimeout(timer);
  }
}
function errorCode(body) {
  if (!body || Array.isArray(body) || typeof body !== 'object') return undefined;
  const error = body.error;
  return error &&
    !Array.isArray(error) &&
    typeof error === 'object' &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
function redactOutput(value) {
  if (Array.isArray(value)) return value.map(redactOutput);
  if (!value || typeof value !== 'object') return value;
  const safeKeys = SAFE_OUTPUT_KEYS_BY_COMMAND[activeCommand] ?? DEFAULT_OUTPUT_KEYS;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      safeKeys.has(key) ? redactOutput(child) : REDACTED,
    ]),
  );
}
async function requireWorkspace(profile, key, expected) {
  const response = await request(profile, key, expected, '/api/v1/account');
  if (response.status >= 400)
    throw new CliError(
      mapExit(response.status, errorCode(response.body)),
      'Workspace preflight failed',
      response.body,
    );
  const envelope = response.body;
  if (envelope.data?.workspaceId !== expected)
    throw new CliError(
      EXIT.authorization,
      'Authenticated workspace does not match required workspace',
      {
        success: false,
        error: {
          code: 'workspace_mismatch',
          message: 'Authenticated workspace does not match required workspace',
        },
      },
    );
}
async function readBody(path) {
  if (!path || path === true) return undefined;
  const text = await readFile(path, 'utf8');
  JSON.parse(text);
  return text;
}
async function readMedia(path) {
  if (!path || path === true) return undefined;
  return readFile(path);
}
function jobState(body) {
  if (!body || Array.isArray(body) || typeof body !== 'object') return undefined;
  const data = body.data;
  return data && !Array.isArray(data) && typeof data === 'object' && typeof data.state === 'string'
    ? data.state
    : undefined;
}
function routePath(route, command, id, flags) {
  const conversationId = flags['conversation-id'];
  const fanUuid = flags['fan-uuid'];
  const postId = flags['post-id'];
  const folderName = flags['folder-name'];
  if (route.path.includes(':folderName') && typeof folderName !== 'string')
    throw new CliError(EXIT.usage, 'Fanvue folder media command requires --folder-name');
  const mediaUuid = flags['media-uuid'];
  if (route.path.includes(':mediaUuid') && typeof mediaUuid !== 'string')
    throw new CliError(EXIT.usage, 'Fanvue vault price command requires --media-uuid');
  if (route.path.includes(':conversationId') && typeof conversationId !== 'string')
    throw new CliError(EXIT.usage, 'Facebook DM command requires --conversation-id');
  if (
    route.path.includes(':fanUuid') &&
    (typeof fanUuid !== 'string' || !WORKSPACE_ID_PATTERN.test(fanUuid))
  )
    throw new CliError(EXIT.usage, 'Fanvue DM command requires UUID --fan-uuid');
  const intentId = flags['intent-id'];
  const rootId = flags['root-id'];
  if (
    route.path.includes(':rootId') &&
    (typeof rootId !== 'string' || !WORKSPACE_ID_PATTERN.test(rootId))
  )
    throw new CliError(EXIT.usage, 'Page DM group command requires UUID --root-id');
  if (
    route.path.includes(':intentId') &&
    (typeof intentId !== 'string' || !WORKSPACE_ID_PATTERN.test(intentId))
  )
    throw new CliError(EXIT.usage, 'Scheduled action requires UUID --intent-id');
  if (
    route.path.includes(':postId') &&
    (typeof postId !== 'string' || !/^[0-9]+(?:_[0-9]+)*$/.test(postId))
  )
    throw new CliError(EXIT.usage, 'Facebook Comments command requires a numeric --post-id');
  const path = route.path
    .replace(':id', encodeURIComponent(id ?? ''))
    .replace(':postId', encodeURIComponent(String(postId ?? '')))
    .replace(':commentId', encodeURIComponent(String(flags['comment-id'] ?? '')))
    .replace(':conversationId', encodeURIComponent(String(conversationId ?? '')))
    .replace(':fanUuid', encodeURIComponent(String(fanUuid ?? '')))
    .replace(':intentId', encodeURIComponent(String(intentId ?? '')))
    .replace(':rootId', encodeURIComponent(String(rootId ?? '')));
  const resourcePath = path
    .replace(':folderName', encodeURIComponent(String(folderName ?? '')))
    .replace(':mediaUuid', encodeURIComponent(String(mediaUuid ?? '')));
  if (
    command !== 'posts:list' &&
    command !== 'destinations:list' &&
    command !== 'publishes:list' &&
    command !== 'fanvue:followers' &&
    command !== 'fanvue:subscribers' &&
    command !== 'fanvue:folders' &&
    command !== 'fanvue:folder-media' &&
    command !== 'fanvue:vault-catalog' &&
    command !== 'fanvue:vault-purchase-fact' &&
    command !== 'fanvue:vault-publication-fact' &&
    command !== 'fanvue-dms:candidates' &&
    command !== 'facebook-comments:posts' &&
    command !== 'facebook-comments:list' &&
    command !== 'facebook-dms:list' &&
    command !== 'facebook-dms:messages'
  )
    return resourcePath;
  const query = new URLSearchParams();
  const names =
    command === 'destinations:list'
      ? ['cursor']
      : command === 'facebook-dms:list' ||
          command === 'facebook-dms:messages' ||
          command === 'facebook-comments:posts' ||
          command === 'facebook-comments:list'
        ? ['limit', 'after']
        : command === 'fanvue:followers' || command === 'fanvue:subscribers'
          ? ['page', 'size', 'cursor']
          : command === 'fanvue:folders'
            ? ['page', 'size', 'media-name']
            : command === 'fanvue:folder-media' || command === 'fanvue:vault-catalog'
              ? ['page', 'size']
              : command === 'fanvue:vault-purchase-fact'
                ? ['fan-uuid']
                : command === 'fanvue:vault-publication-fact'
                  ? ['max-pages']
                  : command === 'fanvue-dms:candidates'
                    ? ['size']
                    : command === 'publishes:list'
                      ? [
                          'cursor',
                          'limit',
                          'states',
                          'approvalStatus',
                          'providerAccountId',
                          'scheduledAfter',
                          'scheduledBefore',
                        ]
                      : ['cursor', 'limit'];
  for (const name of names) {
    const value = flags[name];
    if (typeof value === 'string')
      query.set(
        name === 'media-name'
          ? 'mediaName'
          : name === 'fan-uuid'
            ? 'fanUuid'
            : name === 'max-pages'
              ? 'maxPages'
              : name,
        value,
      );
  }
  const encoded = query.toString();
  return encoded ? `${resourcePath}?${encoded}` : resourcePath;
}
async function pollJob(profile, key, workspace, path, jobId, flags) {
  const timeoutMs = Number(flags['poll-timeout-ms'] ?? 60_000);
  const intervalMs = Number(flags['poll-interval-ms'] ?? 1_000);
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isFinite(intervalMs) ||
    intervalMs < 1
  )
    throw new CliError(EXIT.usage, 'Polling timeout and interval must be positive numbers');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(profile, key, workspace, path);
    if (response.status >= 400)
      throw new CliError(
        mapExit(response.status, errorCode(response.body)),
        'Polling failed',
        response.body,
      );
    const state = jobState(response.body);
    if (state && !['queued', 'claimed', 'dispatching', 'accepted_pending'].includes(state))
      return response.body;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))),
    );
  }
  throw new CliError(EXIT.timeout, 'Polling timed out; the publication job remains durable', {
    success: false,
    error: {
      code: 'poll_timeout',
      message: 'Polling timed out; the publication job remains durable',
    },
    jobId,
    links: { job: path },
  });
}
async function run() {
  const parsed = parseArgs(process.argv.slice(2));
  activeCommand = parsed.command;
  if (parsed.command === 'version') return { success: true, data: { version: '1.8.10' } };
  const route = ROUTES[parsed.command];
  if (!route) throw new CliError(EXIT.usage, `Unknown command ${parsed.command.replace(':', ' ')}`);
  const env = await loadEnvironment(parsed.flags['env-file']);
  const profile = await loadProfile(parsed.flags['profile-file']);
  const baseUrlFlag = parsed.flags['base-url'];
  profile.baseUrl =
    typeof baseUrlFlag === 'string'
      ? baseUrlFlag
      : profile.baseUrl.length > 0
        ? profile.baseUrl
        : (env.PUBLISH_RELAY_BASE_URL ?? '');
  if (!profile.baseUrl) throw new CliError(EXIT.usage, 'A base URL is required');
  const keyName = profile.apiKeyEnv ?? 'PUBLISH_RELAY_API_KEY';
  const key = env[keyName] ?? process.env[keyName];
  if (!key) throw new CliError(EXIT.usage, `API key environment variable ${keyName} is missing`);
  const expected = String(
    parsed.flags['require-workspace'] ??
      profile.workspaceId ??
      profile.workspaceLabel ??
      env.PUBLISH_RELAY_WORKSPACE ??
      process.env.PUBLISH_RELAY_WORKSPACE ??
      '',
  );
  if (parsed.command !== 'health' && !expected)
    throw new CliError(
      EXIT.usage,
      'Authenticated commands require a workspace UUID in the profile or --require-workspace',
    );
  if (parsed.command !== 'health' && !WORKSPACE_ID_PATTERN.test(expected))
    throw new CliError(
      EXIT.usage,
      'A workspace UUID is required; workspace labels cannot authenticate API keys',
    );
  if (MUTATIONS.has(parsed.command)) {
    if (!expected) throw new CliError(EXIT.usage, 'Mutations require an expected workspace');
    await requireWorkspace(profile, key, expected);
  }
  if (route.path.includes(':id') && !parsed.id)
    throw new CliError(EXIT.usage, 'A resource ID is required');
  const path = routePath(route, parsed.command, parsed.id, parsed.flags);
  if (parsed.command === 'publishes:poll' && parsed.id)
    return pollJob(profile, key, expected, path, parsed.id, parsed.flags);
  const mediaPath = parsed.flags.file;
  const media = parsed.command === 'media:upload' ? await readMedia(mediaPath) : undefined;
  if (parsed.command === 'media:upload' && typeof parsed.flags['content-type'] !== 'string')
    throw new CliError(EXIT.usage, 'Media upload requires --content-type');
  const body =
    parsed.command === 'media:upload'
      ? media
      : parsed.command === 'fanvue-guidance:set' && typeof parsed.flags.file === 'string'
        ? JSON.stringify({ guidance: await readFile(parsed.flags.file, 'utf8') })
        : await readBody(parsed.flags['body-file']);
  if (parsed.command === 'media:upload' && !body)
    throw new CliError(EXIT.usage, 'Media upload requires --file');
  if (route.body && !body)
    throw new CliError(
      EXIT.usage,
      'This command requires --body-file (or --file for Fanvue DM guidance)',
    );
  if (
    parsed.command === 'facebook-comments:reply' ||
    parsed.command === 'facebook-comments:schedule'
  ) {
    const actionId = JSON.parse(String(body)).clientActionId;
    if (typeof actionId !== 'string' || actionId !== parsed.flags['idempotency-key'])
      throw new CliError(
        EXIT.usage,
        'Facebook comment clientActionId must match --idempotency-key',
      );
    if (
      typeof parsed.flags['comment-id'] !== 'string' ||
      !/^[0-9]+(?:_[0-9]+)*$/.test(parsed.flags['comment-id'])
    )
      throw new CliError(EXIT.usage, 'Facebook comment reply requires numeric --comment-id');
    if (parsed.command === 'facebook-comments:schedule') {
      const dueAt = JSON.parse(String(body)).dueAt;
      if (typeof dueAt !== 'string' || !Number.isFinite(Date.parse(dueAt)))
        throw new CliError(EXIT.usage, 'Scheduled Page comment requires dueAt');
    }
  }
  if (
    parsed.command === 'facebook-dms:send' ||
    parsed.command === 'facebook-dms:schedule' ||
    parsed.command === 'facebook-dms:group-schedule'
  ) {
    const payload = JSON.parse(String(body));
    const actionId = payload.clientActionId;
    if (typeof actionId !== 'string' || actionId !== parsed.flags['idempotency-key'])
      throw new CliError(EXIT.usage, 'Facebook DM clientActionId must match --idempotency-key');
    if (parsed.command === 'facebook-dms:send' && payload.schedule !== undefined)
      throw new CliError(EXIT.usage, 'Use facebook-dms schedule for a delayed message');
    if (
      parsed.command === 'facebook-dms:group-schedule' &&
      (!Array.isArray(payload.texts) ||
        payload.texts.length < 1 ||
        payload.texts.length > 4 ||
        typeof payload.expectedLatestInboundMessageId !== 'string')
    )
      throw new CliError(
        EXIT.usage,
        'Page DM group requires 1–4 texts and expectedLatestInboundMessageId',
      );
    if (
      parsed.command === 'facebook-dms:schedule' &&
      (!payload.schedule ||
        !Number.isInteger(payload.schedule.earliestDelaySeconds) ||
        !Number.isInteger(payload.schedule.latestDelaySeconds))
    )
      throw new CliError(EXIT.usage, 'Scheduled Page DM requires integer delay seconds');
  }
  if (parsed.command === 'fanvue-dms:group-schedule') {
    const payload = JSON.parse(String(body));
    if (payload.clientActionId !== parsed.flags['idempotency-key'])
      throw new CliError(EXIT.usage, 'Fanvue DM clientActionId must match --idempotency-key');
    if (
      !Array.isArray(payload.bubbles) ||
      payload.bubbles.length < 1 ||
      payload.bubbles.length > 5 ||
      typeof payload.expectedLatestInboundMessageUuid !== 'string' ||
      typeof payload.expectedLatestInboundAt !== 'string' ||
      typeof payload.earliestAt !== 'string' ||
      typeof payload.latestAt !== 'string'
    )
      throw new CliError(
        EXIT.usage,
        'Fanvue DM group requires 1–5 bubbles, inbound identity and an explicit due window',
      );
  }
  if (parsed.command === 'proposals:create') {
    const actionId = JSON.parse(String(body)).clientActionId;
    if (typeof actionId !== 'string' || actionId !== parsed.flags['idempotency-key'])
      throw new CliError(EXIT.usage, 'Proposal clientActionId must match --idempotency-key');
  }
  const idempotencyKey = parsed.flags['idempotency-key'];
  if (
    MUTATIONS.has(parsed.command) &&
    parsed.command !== 'facebook-dms:cancel' &&
    parsed.command !== 'facebook-comments:cancel' &&
    parsed.command !== 'facebook-dms:group-cancel' &&
    parsed.command !== 'fanvue-dms:group-cancel' &&
    parsed.command !== 'facebook-dms:memory-upsert' &&
    typeof idempotencyKey !== 'string'
  )
    throw new CliError(EXIT.usage, 'Mutations require --idempotency-key');
  const requestBody = Buffer.isBuffer(body) ? new Uint8Array(body) : body;
  const response = await request(profile, key, expected || undefined, path, {
    method: route.method,
    ...(requestBody ? { body: requestBody } : {}),
    headers: {
      ...(parsed.command === 'media:upload'
        ? {
            'content-type': String(parsed.flags['content-type'] ?? ''),
            'x-file-name': basename(String(mediaPath)),
          }
        : body
          ? { 'content-type': 'application/json' }
          : {}),
      ...(typeof idempotencyKey === 'string' ? { 'idempotency-key': idempotencyKey } : {}),
    },
  });
  if (response.status >= 400)
    throw new CliError(
      mapExit(response.status, errorCode(response.body)),
      'Request failed',
      response.body,
    );
  return response.body;
}
try {
  process.stdout.write(`${JSON.stringify(redactOutput(await run()))}\n`);
} catch (error) {
  const cliError =
    error instanceof CliError
      ? error
      : new CliError(EXIT.usage, error instanceof Error ? error.message : 'Invalid input');
  process.stdout.write(
    `${JSON.stringify(redactOutput(cliError.data ?? { success: false, error: { code: 'cli_error', message: cliError.message } }))}\n`,
  );
  process.stderr.write(`${basename(process.argv[1] ?? 'publish-relay')}: ${cliError.message}\n`);
  process.exitCode = cliError.exitCode;
}
//# sourceMappingURL=cli.js.map
