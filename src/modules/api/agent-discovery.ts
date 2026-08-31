import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';

const VERSION = '1.0.0';
const AGENTS_TEXT = `# Publish Relay agent discovery
Skill: /publish-relay-skill/SKILL.md
Manifest: /publish-relay-skill/manifest.json
API contract: /api/openapi.json
CLI: publish-relay --help
Read the skill and manifest before calling the API. Never send credentials to discovery URLs.
`;
const SKILL_MARKDOWN = `---
name: publish-relay
description: "Create, inspect, and reconcile workspace-scoped Publish Relay posts and publication jobs."
---

# Publish Relay

Read the manifest and API contract first. Authenticate with a workspace service key and request only the capabilities needed by the command.

Use a unique idempotency key for every intended mutation. Reuse it only to replay the same request. Keep all list pagination server-side and follow returned cursors.

For accepted or unknown publication outcomes, poll the job detail until it reaches a terminal state. Reconcile unknown X outcomes through lookup; never retry a publish blindly.

Treat workspace boundaries as absolute. A missing resource may represent an absent or foreign-workspace ID; do not probe across workspaces.

Use the shipped non-interactive CLI for scripts. Read command help before execution, use placeholder credentials in examples, and handle non-zero exits and structured API errors. Update checks may warn about a newer manifest version but must never self-update.

X live publish, credential migration, reconnect, revocation, and capability canaries require a separate explicitly authorized ticket with rollback criteria.
`;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function registerAgentDiscoveryRoutes(application: FastifyInstance): void {
  application.get('/agents.txt', (_request, reply) =>
    reply.header('cache-control', 'public, max-age=300').type('text/plain').send(AGENTS_TEXT),
  );
  application.get('/publish-relay-skill/SKILL.md', (_request, reply) =>
    reply.header('cache-control', 'public, max-age=300').type('text/markdown').send(SKILL_MARKDOWN),
  );
  application.get('/publish-relay-skill/manifest.json', () => ({
    data: {
      version: VERSION,
      assets: [
        { path: '/agents.txt', sha256: sha256(AGENTS_TEXT) },
        { path: '/publish-relay-skill/SKILL.md', sha256: sha256(SKILL_MARKDOWN) },
      ],
      cli: { command: 'publish-relay', updatePolicy: 'warn-only' },
    },
    error: null,
  }));
}
