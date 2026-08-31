# Publish Relay Backend Guide

## Accepted foundation

- Node.js 24 + strict TypeScript modular monolith using Fastify.
- PostgreSQL as the only durable state store.
- REST API for UI and project integrations.
- Provider adapters behind one explicit interface.
- Durable scheduled jobs with atomic claim/lease, idempotency, bounded retry/backoff, cancellation, reconciliation, and audit history.
- Scheduler persistence lives in `src/modules/scheduler`: claims use one `FOR UPDATE SKIP LOCKED` update, expired dispatch leases are marked reconciliation-required, and retry timing uses bounded full jitter. Stable publication idempotency derives only from job, immutable revision, and provider account identity.
- Cross-workspace worker claims require the dedicated database worker role documented by deployment; all subsequent workspace-specific scheduler mutations establish `app.workspace_id` through `withTenantTransaction` before forced-RLS access.
- Secrets referenced through approved runtime/Vault mechanisms; never stored in plaintext project docs or logs.

- The application has one repository and build with separate `web` and `worker` process entrypoints.
- Domain modules own their domain, application, and infrastructure internals. Cross-module imports use public contracts; another module's infrastructure is private and guarded by lint plus a regression test.
- Runtime input is validated with Zod. HTTP responses use `{ data, error }`. Pino logging is supplied through Fastify and must never include secrets or post bodies.
- Vitest owns unit/integration tests and Playwright owns rendered browser acceptance.

Concrete architecture, security, persistence, job, and deployment decisions are frozen in `projects/publish-relay/library/decisions.md` ADR-001 through ADR-007.

## Agent API v1 contract

- Shared success/error envelope builders and the signed keyset cursor codec live in `src/modules/api/contract.ts`; routes must use these canonical boundaries rather than hand-building response shapes or cursor parsing.
- Collection cursors are versioned HMAC-SHA256 tokens bound to normalized filters and expiry. Malformed, tampered, expired, or filter-mismatched cursors fail closed and must map to HTTP 400 without restarting pagination.

## Persistence and tenant context

- Drizzle schema declarations live in `src/database/schema.ts`; immutable forward migrations live in `migrations/`.
- Tenant repositories require an explicit `workspaceId` and execute through `withTenantTransaction`, which applies transaction-local `app.workspace_id` before any tenant query.
- Tenant tables use both repository predicates and forced PostgreSQL RLS policies. Adding a tenant table requires `workspace_id`, indexes appropriate to its access path, and an RLS policy in the same migration.
- Browser session and API-key bearer material is never persisted. Store SHA-256 hashes; API keys expose only a public `pr_` prefix beside the hash. Revocation and expiry are checked before authorization.
- Browser session cookies carry the workspace UUID beside an opaque token so forced tenant RLS can be established before the hashed session lookup. Login rotates prior sessions, protected requests reload the live membership role, and state-changing browser routes require a matching double-submit CSRF token.
- Audit events are append-only and accept allowlisted, redacted metadata only. Secrets and content bodies do not belong in audit or application logs.

## Provider credentials and OAuth

- Provider secrets use AES-256-GCM envelope encryption: a random data key encrypts each record and a versioned master key wraps only that data key. Rotation uses optimistic record versions and never rewrites plaintext.
- Credential, provider connection/account, and OAuth transaction rows are workspace-scoped tenant tables with forced RLS. Repository calls run inside `withTenantTransaction` and repeat the workspace predicate.
- OAuth state is persisted only as a hash, expires quickly, and is atomically consumed once. Provider adapters receive access tokens only in memory and return allowlisted account discovery DTOs.
- Revocation is idempotent. Reconnect flows update the canonical connection rather than treating credentials copied from another scheduler as portable authorization.

## Provider adapter contract

- Provider adapters implement the versioned `ProviderAdapter` contract for connect, discover, validate, stage, publish, lookup, and revoke.
- Core content is an explicit text, quote, or article union with typed media references. Adapters reject unsupported input; they never silently truncate or transform it.
- Publishing returns one typed outcome: published, accepted pending, unknown/reconciliation-required, or failed with auth, rate-limit, validation, transient, or permanent classification.
- Staging is idempotent by caller-supplied key. An unknown publish outcome must be reconciled through lookup rather than retried blindly.
- The X transport uses OAuth 1.0a User Context with credentials supplied only after envelope decryption. It signs native `/2/users/me`, `/2/tweets`, and lookup requests, and never logs or persists token material.
- X does not currently have a proven provider-side idempotency header in this product. The scheduler remains the idempotency owner; ambiguous POST transport failures become reconciliation-required rather than blind retries.
- X connection uses the OAuth 1.0a request-token, authorization redirect, verifier callback, and access-token exchange. Request-token secrets must use the encrypted, one-time transaction lifecycle before this flow is exposed by HTTP routes. Revocation and native article publishing remain fail-closed until their provider endpoints and account capabilities are verified. Pre-uploaded media IDs are mapped exactly; media upload lifecycle and limits remain separate evidence-gated work.
- The X OAuth service hashes the request token as callback correlation, encrypts its request-token secret in the provider-neutral OAuth transaction credential, atomically consumes and deletes that one-time secret before exchange, then stores the resulting user credential through the canonical reconnect lifecycle.

## Content and media persistence

- `posts` owns mutable publication intent while `post_revisions` records immutable, numbered content snapshots. The database rejects revision update and deletion.
- `revision_media` links ordered workspace media to a revision. `publication_jobs` creates one independent account target per revision, and `provider_staging_artifacts` records temporary provider-side resources that require deterministic cleanup.
- Every content/media table is workspace-scoped with explicit repository predicates and forced RLS. Media identity records a storage key plus byte-derived SHA-256, MIME type, and byte size; application services must not trust client metadata for those fields.
