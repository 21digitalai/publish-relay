#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Profile {
  baseUrl: string;
  workspaceId?: string;
  workspaceLabel?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
}

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
} as const;
const MUTATIONS = new Set(['posts:create', 'media:upload']);
const ROUTES: Record<string, { method: string; path: string; body?: boolean }> = {
  'account:current': { method: 'GET', path: '/api/v1/account' },
  'posts:create': { method: 'POST', path: '/api/v1/posts', body: true },
  'posts:list': { method: 'GET', path: '/api/v1/posts' },
  'posts:show': { method: 'GET', path: '/api/v1/posts/:id' },
  'media:upload': { method: 'POST', path: '/api/v1/media' },
  'publishes:show': { method: 'GET', path: '/api/v1/jobs/:id' },
  'publishes:poll': { method: 'GET', path: '/api/v1/jobs/:id' },
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
] as const;
const SAFE_OUTPUT_KEYS_BY_COMMAND: Record<string, ReadonlySet<string>> = {
  'account:current': new Set([...ENVELOPE_OUTPUT_KEYS, 'prefix', 'capabilities', 'expiresAt']),
  'posts:create': new Set([
    ...ENVELOPE_OUTPUT_KEYS,
    'self',
    'jobs',
    'mediaCount',
    'previewMediaId',
    'effectiveProviderSettings',
    'schemaVersion',
    'title',
    'description',
    'privacyStatus',
    'madeForKids',
    'notifySubscribers',
    'tags',
    'categoryId',
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
    'handle',
    'provider',
    'mediaCount',
    'previewMediaId',
    'effectiveProviderSettings',
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
  ]),
};
const DEFAULT_OUTPUT_KEYS = new Set(ENVELOPE_OUTPUT_KEYS);
const REDACTED = '[REDACTED]';
let activeCommand = 'error';

class CliError extends Error {
  public constructor(
    public readonly exitCode: number,
    message: string,
    public readonly data?: Json,
  ) {
    super(message);
  }
}

function parseArgs(argv: string[]): {
  command: string;
  id?: string;
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
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

function rejectSecrets(value: unknown, path = 'profile'): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(secret|token|password|api.?key(?!Env))/i.test(key))
      throw new CliError(EXIT.usage, `${path}.${key} may not contain secret material`);
    rejectSecrets(child, `${path}.${key}`);
  }
}

async function loadEnvironment(path: string | true | undefined): Promise<Record<string, string>> {
  if (!path || path === true) return {};
  const result: Record<string, string> = {};
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

async function loadProfile(path: string | true | undefined): Promise<Profile> {
  if (!path || path === true) return { baseUrl: process.env.PUBLISH_RELAY_BASE_URL ?? '' };
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  rejectSecrets(parsed);
  if (!parsed || typeof parsed !== 'object')
    throw new CliError(EXIT.usage, 'Profile must be a JSON object');
  return parsed as Profile;
}

function mapExit(status: number, code?: string): number {
  if (status === 401) return EXIT.auth;
  if (status === 403 || code === 'workspace_mismatch') return EXIT.authorization;
  if (status === 400 || status === 404 || status === 422) return EXIT.validation;
  if (status === 409) return EXIT.conflict;
  if (status === 429) return EXIT.rate;
  if (status >= 500) return EXIT.transient;
  return EXIT.terminal;
}

async function request(
  profile: Profile,
  key: string,
  workspace: string | undefined,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Json }> {
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
    const body = (await response.json()) as Json;
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

function errorCode(body: Json): string | undefined {
  if (!body || Array.isArray(body) || typeof body !== 'object') return undefined;
  const error = body.error;
  return error &&
    !Array.isArray(error) &&
    typeof error === 'object' &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function redactOutput(value: Json): Json {
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

async function requireWorkspace(profile: Profile, key: string, expected: string): Promise<void> {
  const response = await request(profile, key, expected, '/api/v1/account');
  if (response.status >= 400)
    throw new CliError(
      mapExit(response.status, errorCode(response.body)),
      'Workspace preflight failed',
      response.body,
    );
  const envelope = response.body as { data?: { workspaceId?: string; workspaceLabel?: string } };
  if (envelope.data?.workspaceId !== expected && envelope.data?.workspaceLabel !== expected)
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

async function readBody(path: string | true | undefined): Promise<string | undefined> {
  if (!path || path === true) return undefined;
  const text = await readFile(path, 'utf8');
  JSON.parse(text);
  return text;
}

async function readMedia(path: string | true | undefined): Promise<Buffer | undefined> {
  if (!path || path === true) return undefined;
  return readFile(path);
}

function jobState(body: Json): string | undefined {
  if (!body || Array.isArray(body) || typeof body !== 'object') return undefined;
  const data = body.data;
  return data && !Array.isArray(data) && typeof data === 'object' && typeof data.state === 'string'
    ? data.state
    : undefined;
}

function routePath(
  route: { path: string },
  command: string,
  id: string | undefined,
  flags: Record<string, string | true>,
): string {
  const path = route.path.replace(':id', encodeURIComponent(id ?? ''));
  if (command !== 'posts:list') return path;
  const query = new URLSearchParams();
  for (const name of ['cursor', 'limit']) {
    const value = flags[name];
    if (typeof value === 'string') query.set(name, value);
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

async function pollJob(
  profile: Profile,
  key: string,
  workspace: string,
  path: string,
  jobId: string,
  flags: Record<string, string | true>,
): Promise<Json> {
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

async function run(): Promise<Json> {
  const parsed = parseArgs(process.argv.slice(2));
  activeCommand = parsed.command;
  if (parsed.command === 'version') return { success: true, data: { version: '1.0.0' } };
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
      'Authenticated commands require a workspace in the profile or --require-workspace',
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
    parsed.command === 'media:upload' ? media : await readBody(parsed.flags['body-file']);
  if (parsed.command === 'media:upload' && !body)
    throw new CliError(EXIT.usage, 'Media upload requires --file');
  if (route.body && !body) throw new CliError(EXIT.usage, 'This command requires --body-file');
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
