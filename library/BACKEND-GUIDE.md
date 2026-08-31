# Publish Relay Backend Guide

## Direction pending Architect approval

- Node.js + TypeScript modular monolith.
- PostgreSQL as the only durable state store.
- REST API for UI and project integrations.
- Provider adapters behind one explicit interface.
- Durable scheduled jobs with atomic claim/lease, idempotency, bounded retry/backoff, cancellation, reconciliation, and audit history.
- Secrets referenced through approved runtime/Vault mechanisms; never stored in plaintext project docs or logs.

The Architect ticket must freeze concrete framework, schema, auth/session, encryption, worker, migration, testing, and deployment decisions before Builder implements foundations.

