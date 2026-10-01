# Publish Relay Product Guide

## North star

Users can register, connect multiple social accounts, schedule content through the UI or API, understand exactly what will publish and when, and recover safely from failures.

## Initial scope

- Generic clients may hand approved local media to a tenant-scoped draft and send the user into Relay's canonical cockpit composer. Relay owns retention, destination choice, scheduling, and the one-time draft-to-post receipt; source clients keep only their opaque correlation and optional HTTPS return link.

- Authentication and protected application shell.
- Multi-tenant workspaces/projects.
- Multiple provider accounts per workspace.
- X as the first complete provider.
- Connected accounts, queue/list, calendar/day/hour views, job details, pre-dispatch edit/cancel, retry, and external result links.
- Project API keys for machine clients.

## Follow-on scope

- Instagram publishing.
- Facebook Pages publishing.
- One Meta connection discovers managed Facebook Pages and their linked Instagram Professional
  accounts as separate destinations. Connection/discovery does not enable publishing by itself;
  Instagram and Facebook publishing remain independent adapter slices with independent jobs and
  outcomes.
- Meta phase-one composition is destination-first. Instagram accepts one image or a 2–10 image
  carousel with a caption; Facebook Pages accept one image or an HTTPS link with a message. A
  combined Instagram + Facebook composition is intentionally limited to one image plus shared
  caption/message, and creates one immutable target payload and job per destination. This prepares
  scheduling only; no Meta publishing endpoint exists in this phase.

## Explicit non-goals for the first release

- Commercial storefront, billing, pricing, subscriptions, plan names, quotas, and marketing pages are not Core features.
- Core exposes neutral policy and factual usage boundaries with an allow-all standalone implementation; it does not know why a future injected implementation may deny an action.
- Every capacity-changing command evaluates the same typed action-policy contract once before mutation. Inputs contain only actor/workspace identity, requested Core facts, current usage facts, request context, and the active transaction. Denials expose stable neutral codes and safe metadata; standalone Core injects the allow-all implementation.
- Connecting or reconnecting X is admitted before the external OAuth handshake begins, so denial leaves no provider request, credential, OAuth transaction, connection, account, storage, or idempotency residue.
- Current registration/login remains part of Core. A future local auth mode may enter a default owner/workspace directly without removing tenant identity from the domain.

- Marketing homepage.
- Broad provider parity before each adapter is proven independently.
- Social inbox/community management.
- Analytics warehouse.
- AI content generation inside Publish Relay.
- Enterprise organization/role complexity beyond the minimum sound tenant model.
