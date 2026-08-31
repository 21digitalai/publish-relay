# Publish Relay Backend Guide

## Accepted foundation

- Node.js 24 + strict TypeScript modular monolith using Fastify.
- PostgreSQL as the only durable state store.
- REST API for UI and project integrations.
- Provider adapters behind one explicit interface.
- Durable scheduled jobs with atomic claim/lease, idempotency, bounded retry/backoff, cancellation, reconciliation, and audit history.
- Secrets referenced through approved runtime/Vault mechanisms; never stored in plaintext project docs or logs.

- The application has one repository and build with separate `web` and `worker` process entrypoints.
- Domain modules own their domain, application, and infrastructure internals. Cross-module imports use public contracts; another module's infrastructure is private and guarded by lint plus a regression test.
- Runtime input is validated with Zod. HTTP responses use `{ data, error }`. Pino logging is supplied through Fastify and must never include secrets or post bodies.
- Vitest owns unit/integration tests and Playwright owns rendered browser acceptance.

Concrete architecture, security, persistence, job, and deployment decisions are frozen in `projects/publish-relay/library/decisions.md` ADR-001 through ADR-007.

## Persistence and tenant context

- Drizzle schema declarations live in `src/database/schema.ts`; immutable forward migrations live in `migrations/`.
- Tenant repositories require an explicit `workspaceId` and execute through `withTenantTransaction`, which applies transaction-local `app.workspace_id` before any tenant query.
- Tenant tables use both repository predicates and forced PostgreSQL RLS policies. Adding a tenant table requires `workspace_id`, indexes appropriate to its access path, and an RLS policy in the same migration.
- Browser session and API-key bearer material is never persisted. Store SHA-256 hashes; API keys expose only a public `pr_` prefix beside the hash. Revocation and expiry are checked before authorization.
- Browser session cookies carry the workspace UUID beside an opaque token so forced tenant RLS can be established before the hashed session lookup. Login rotates prior sessions, protected requests reload the live membership role, and state-changing browser routes require a matching double-submit CSRF token.
- Audit events are append-only and accept allowlisted, redacted metadata only. Secrets and content bodies do not belong in audit or application logs.
