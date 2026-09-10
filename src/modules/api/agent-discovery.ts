import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const CONTRACT_VERSION = '1.2.0';
const CLI_VERSION = '1.2.0';
const CACHE_CONTROL = 'public, max-age=300';
const CLI_JAVASCRIPT = readFileSync(
  new URL('./assets/publish-relay-cli.js', import.meta.url),
  'utf8',
);
const AGENTS_TEXT = `# Publish Relay agent discovery
Skill: /publish-relay-skill/SKILL.md
Manifest: /publish-relay-skill/manifest.json
API contract: /api/v1/openapi.json
CLI: /publish-relay-skill/publish-relay-cli.js
Read the skill and manifest before calling the API. Never send credentials to discovery URLs.
`;
const SKILL_MARKDOWN = `---
name: publish-relay
description: "Create, inspect, and reconcile workspace-scoped Publish Relay posts and publication jobs."
---

# Publish Relay

Read the manifest and API contract first. Authenticate with either a workspace API key or a delegated access token and request only the capabilities needed by the command.

## Delegated connection

Public clients use authorization code + PKCE S256. Generate a fresh verifier, challenge, and opaque state, then open /connect/authorize with client_id, an exactly registered redirect_uri, state, code_challenge, code_challenge_method=S256, and a space-delimited scope. After the user logs in and approves, verify the returned state and exchange the short-lived code at POST /connect/token. The callback contains no durable credential; access and refresh tokens exist only in the token response and must be encrypted at rest by the client.

Send the delegated access token in the Authorization header using the Bearer scheme, together with X-Publish-Relay-Workspace, on the same /api/v1 routes used by API keys. Refresh through POST /connect/token with grant_type=refresh_token before retrying an expired request. Disconnect by revoking the grant in Relay Settings > Integrations; reconnect creates a new grant and never reuses an unrelated API key or old grant. The Open Clips development registration is client_id=open-clips-dev with exact callback http://127.0.0.1:43123/callback and scopes destinations:read schedules:read schedules:write content:write publishes:retry.

## Capabilities

- account current: authenticated key only; use it as the read-first workspace guard.
- posts list/show and publishes show/poll: schedules:read.
- posts create: schedules:write. Live provider submission also requires publishes:submit on the server-side operation.
- media upload: content:write. Send exact local bytes with --file, an explicit --content-type, and a unique idempotency key. Remote URL fetching is not supported.
- drafts create/show: content:write. Create a tenant-scoped imported-media draft with a stable opaque externalId, ordered ready mediaIds, and optional label/HTTPS returnUrl. Open the returned cockpit link for the user to complete the canonical Relay composer; the resulting post link appears after that one-time transition.
- destinations list: destinations:read.
- publishes retry: publishes:retry. Retry only a failed job after inspection; Relay rejects jobs whose outcome still requires reconciliation.
- Audit operations require audit:read when they become available. Do not infer capabilities from CLI command visibility.

For the shipped CLI, set PUBLISH_RELAY_BASE_URL, PUBLISH_RELAY_API_KEY, and PUBLISH_RELAY_WORKSPACE. Profiles may name the API-key environment variable but must never contain its value. Delegated clients call the same HTTP contract directly with their encrypted token store. Before a mutation, verify the expected workspace through a read endpoint and keep X-Publish-Relay-Workspace explicit.

Use a unique idempotency key for every intended mutation. Reuse it only to replay the same request. Keep all list pagination server-side and follow returned cursors.

For accepted or unknown publication outcomes, poll the returned job link with bounded --poll-timeout-ms and --poll-interval-ms values. A timeout leaves the durable job intact: inspect it again before deciding what to do. Reconcile unknown X outcomes through lookup; never retry a publish blindly.

Destination settings are account-scoped defaults. Send only per-job overrides that differ from the selected destination. Create/schedule success and job detail return the complete persisted effectiveProviderSettings snapshot, including values resolved from destination defaults; treat that response as authoritative and do not reconstruct effective settings from the sparse request.

Treat workspace boundaries as absolute. A missing resource may represent an absent or foreign-workspace ID; do not probe across workspaces.

Use the shipped non-interactive CLI for scripts. Read command help before execution, use placeholder credentials in examples, and handle non-zero exits and structured API errors. Update checks may warn about a newer manifest version but must never self-update.

## Stable exits and recovery

- 2 usage/config: fix flags, profile, environment, body JSON, or idempotency input; do not send the same malformed command again unchanged.
- 3 authentication: replace or renew the workspace service key through the approved key owner.
- 4 authorization/workspace: stop; verify the expected workspace and required capability before retrying.
- 5 validation/not found: correct the resource or payload. A missing resource may be tenant-hidden; do not probe other workspaces.
- 6 conflict/idempotency: inspect the canonical resource and reuse a key only for the identical request.
- 7 rate limit: honor Retry-After or bounded backoff, then retry the identical safe operation.
- 8 transient/server/network: inspect any returned job or resource link before retrying a mutation.
- 9 terminal: stop and inspect the structured error; do not retry blindly.
- 10 poll timeout: the job remains durable; resume bounded polling from its direct job link.

Read-only example: PUBLISH_RELAY_API_KEY=<workspace-service-key> node publish-relay-cli.js account current --base-url https://relay.example --require-workspace <workspace-id>.
Destination discovery example: add destinations list with the same --base-url and --require-workspace, then use the returned destination id in providerAccountIds. The list never returns credentials or provider defaults.
Mutation example: add posts create with --body-file <request.json> and --idempotency-key <unique-operation-key> only after the read-first workspace check.
Media example: add media upload with --file <image-path> --content-type image/png and --idempotency-key <unique-operation-key>.
Draft handoff example: upload each local asset, then run drafts create with a JSON body containing externalId and the returned mediaIds plus a unique idempotency key. Retain the returned self and cockpit links; do not build a second scheduler UI in the source client.
YouTube scheduling example: set title and any sparse provider override in the posts create body, select the connected destination, then retain data.jobs[].effectiveProviderSettings from the response. Do not repeat unchanged privacy, Made for Kids, notification, tags, or category defaults on every request.
Retry example: after publishes show confirms state=failed and no reconciliation is required, run publishes retry <job-id> with a unique --idempotency-key. Poll the same job link afterward; never retry accepted_pending or unknown outcomes blindly.

X live publish, credential migration, reconnect, revocation, and capability canaries require a separate explicitly authorized ticket with rollback criteria.
`;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function registerAgentDiscoveryRoutes(application: FastifyInstance): void {
  application.get('/agents.txt', (_request, reply) =>
    reply.header('cache-control', CACHE_CONTROL).type('text/plain').send(AGENTS_TEXT),
  );
  application.get('/publish-relay-skill/SKILL.md', (_request, reply) =>
    reply.header('cache-control', CACHE_CONTROL).type('text/markdown').send(SKILL_MARKDOWN),
  );
  application.get('/publish-relay-skill/publish-relay-cli.js', (_request, reply) =>
    reply.header('cache-control', CACHE_CONTROL).type('text/javascript').send(CLI_JAVASCRIPT),
  );
  application.get('/publish-relay-skill/manifest.json', (_request, reply) =>
    reply.header('cache-control', CACHE_CONTROL).send({
      data: {
        contractVersion: CONTRACT_VERSION,
        cliVersion: CLI_VERSION,
        assets: [
          { path: '/agents.txt', sha256: sha256(AGENTS_TEXT) },
          { path: '/publish-relay-skill/SKILL.md', sha256: sha256(SKILL_MARKDOWN) },
          {
            path: '/publish-relay-skill/publish-relay-cli.js',
            sha256: sha256(CLI_JAVASCRIPT),
          },
        ],
        cli: {
          path: '/publish-relay-skill/publish-relay-cli.js',
          command: 'publish-relay',
          updatePolicy: 'warn-only',
        },
      },
      error: null,
    }),
  );
}
