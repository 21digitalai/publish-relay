import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const CONTRACT_VERSION = '1.0.0';
const CLI_VERSION = '1.0.0';
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

Read the manifest and API contract first. Authenticate with a workspace service key and request only the capabilities needed by the command.

## Capabilities

- account current: authenticated key only; use it as the read-first workspace guard.
- posts list/show and publishes show/poll: schedules:read.
- posts create: schedules:write. Live provider submission also requires publishes:submit on the server-side operation.
- media upload: content:write. Send exact local bytes with --file, an explicit --content-type, and a unique idempotency key. Remote URL fetching is not supported.
- Retry and audit operations require publishes:retry and audit:read respectively when those commands become available. Do not infer capabilities from CLI command visibility.

Set PUBLISH_RELAY_BASE_URL, PUBLISH_RELAY_API_KEY, and PUBLISH_RELAY_WORKSPACE. Profiles may name the API-key environment variable but must never contain its value. Before a mutation, run account current and require the expected workspace with --require-workspace.

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
Mutation example: add posts create with --body-file <request.json> and --idempotency-key <unique-operation-key> only after the read-first workspace check.
Media example: add media upload with --file <image-path> --content-type image/png and --idempotency-key <unique-operation-key>.
YouTube scheduling example: set title and any sparse provider override in the posts create body, select the connected destination, then retain data.jobs[].effectiveProviderSettings from the response. Do not repeat unchanged privacy, Made for Kids, notification, tags, or category defaults on every request.

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
