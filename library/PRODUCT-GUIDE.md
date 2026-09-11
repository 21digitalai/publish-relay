# Publish Relay Product Guide

## North star

Users can register, connect multiple social accounts, schedule content through the UI or API, understand exactly what will publish and when, and recover safely from failures.

## Initial scope

- Generic clients may hand approved local media to a tenant-scoped draft and send the user into Relay's canonical cockpit composer. Relay owns retention, destination choice, scheduling, and the one-time draft-to-post receipt; source clients keep only their opaque correlation and optional HTTPS return link.

- Passwordless human authentication and protected application shell: hosted deployments email 15-minute one-time links, while development displays the link without sending email. Login is email-only and does not create accounts; signup remains explicit.
- Multi-tenant workspaces/projects.
- Multiple provider accounts per workspace.
- X as the first complete provider.
- Connected accounts, queue/list, calendar/day/hour views, job details, pre-dispatch edit/cancel, retry, and external result links.
- Project API keys for machine clients.

## Follow-on scope

- Instagram publishing.
- Facebook Pages publishing.

## Explicit non-goals for the first release

- Commercial storefront, billing, pricing, subscriptions, plan names, quotas, and marketing pages are not Core features.
- Core exposes neutral policy and factual usage boundaries with an allow-all standalone implementation; it does not know why a future injected implementation may deny an action.
- Every capacity-changing command evaluates the same typed action-policy contract once before mutation. Inputs contain only actor/workspace identity, requested Core facts, current usage facts, request context, and the active transaction. Denials expose stable neutral codes and safe metadata; standalone Core injects the allow-all implementation.
- Connecting or reconnecting X is admitted before the external OAuth handshake begins, so denial leaves no provider request, credential, OAuth transaction, connection, account, storage, or idempotency residue.
- Registration/login remains part of Core. Human browser login uses magic links and secure server sessions; API keys remain machine-only. A future local auth mode may enter a default owner/workspace directly without removing tenant identity from the domain.

- Marketing homepage.
- Thirty-provider parity with Postiz.
- Social inbox/community management.
- Analytics warehouse.
- AI content generation inside Publish Relay.
- Enterprise organization/role complexity beyond the minimum sound tenant model.
