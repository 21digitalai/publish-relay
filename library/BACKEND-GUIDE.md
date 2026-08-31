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
