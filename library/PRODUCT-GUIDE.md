# Publish Relay Product Guide

## North star

Users can register, connect multiple social accounts, schedule content through the UI or API, understand exactly what will publish and when, and recover safely from failures.

## Initial scope

- Authentication and protected application shell.
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
- Current registration/login remains part of Core. A future local auth mode may enter a default owner/workspace directly without removing tenant identity from the domain.

- Marketing homepage.
- Thirty-provider parity with Postiz.
- Social inbox/community management.
- Analytics warehouse.
- AI content generation inside Publish Relay.
- Enterprise organization/role complexity beyond the minimum sound tenant model.
