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
  'fanvue:create-chat',
  'facebook-comments:reply',
  'facebook-dms:send',
]);
const ROUTES = {
  'account:current': { method: 'GET', path: '/api/v1/account' },
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
  'fanvue:followers': { method: 'GET', path: '/api/v1/fanvue/accounts/:id/followers' },
  'fanvue:subscribers': { method: 'GET', path: '/api/v1/fanvue/accounts/:id/subscribers' },
  'fanvue-guidance:show': { method: 'GET', path: '/api/v1/fanvue/accounts/:id/guidance' },
  'fanvue-guidance:set': {
    method: 'PATCH',
    path: '/api/v1/fanvue/accounts/:id/guidance',
    body: true,
  },
  'fanvue:create-chat': {
    method: 'POST',
    path: '/api/v1/fanvue/accounts/:id/chats',
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
  ]),
  'facebook-dms:messages': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'participantId',
    'displayName',
    'messages',
    'nextCursor',
    'text',
    'createdAt',
    'senderId',
  ]),
  'facebook-comments:reply': new Set([...ENVELOPE_OUTPUT_KEYS, 'commentId', 'failureStatus']),
  'facebook-dms:send': new Set([...ENVELOPE_OUTPUT_KEYS, 'messageId', 'failureStatus']),
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
  'fanvue-guidance:show': new Set([...ENVELOPE_OUTPUT_KEYS, 'guidance']),
  'fanvue-guidance:set': new Set([...ENVELOPE_OUTPUT_KEYS, 'guidance']),
  'fanvue:create-chat': new Set([...ENVELOPE_OUTPUT_KEYS, 'fanUuid', 'failureStatus']),
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
    'self',
  ]),
  'publishes:list': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'items',
    'nextCursor',
    'scheduledAt',
    'updatedAt',
    'destination',
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
  const postId = flags['post-id'];
  if (route.path.includes(':conversationId') && typeof conversationId !== 'string')
    throw new CliError(EXIT.usage, 'Facebook DM command requires --conversation-id');
  if (
    route.path.includes(':postId') &&
    (typeof postId !== 'string' || !/^[0-9]+(?:_[0-9]+)*$/.test(postId))
  )
    throw new CliError(EXIT.usage, 'Facebook Comments command requires a numeric --post-id');
  const path = route.path
    .replace(':id', encodeURIComponent(id ?? ''))
    .replace(':postId', encodeURIComponent(String(postId ?? '')))
    .replace(':commentId', encodeURIComponent(String(flags['comment-id'] ?? '')))
    .replace(':conversationId', encodeURIComponent(String(conversationId ?? '')));
  if (
    command !== 'posts:list' &&
    command !== 'destinations:list' &&
    command !== 'publishes:list' &&
    command !== 'fanvue:followers' &&
    command !== 'fanvue:subscribers' &&
    command !== 'facebook-comments:posts' &&
    command !== 'facebook-comments:list' &&
    command !== 'facebook-dms:list' &&
    command !== 'facebook-dms:messages'
  )
    return path;
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
          : command === 'publishes:list'
            ? [
                'cursor',
                'limit',
                'states',
                'providerAccountId',
                'scheduledAfter',
                'scheduledBefore',
              ]
            : ['cursor', 'limit'];
  for (const name of names) {
    const value = flags[name];
    if (typeof value === 'string') query.set(name, value);
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
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
  if (parsed.command === 'version') return { success: true, data: { version: '1.7.0' } };
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
  if (parsed.command === 'facebook-comments:reply') {
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
  }
  if (parsed.command === 'facebook-dms:send') {
    const actionId = JSON.parse(String(body)).clientActionId;
    if (typeof actionId !== 'string' || actionId !== parsed.flags['idempotency-key'])
      throw new CliError(EXIT.usage, 'Facebook DM clientActionId must match --idempotency-key');
  }
  const idempotencyKey = parsed.flags['idempotency-key'];
  if (MUTATIONS.has(parsed.command) && typeof idempotencyKey !== 'string')
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
