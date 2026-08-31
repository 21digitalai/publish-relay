# Publish Relay

Standalone multi-tenant social scheduling product implemented as a TypeScript modular monolith.

## Requirements

- Node.js 24+
- npm 11+

## Commands

- `npm ci` — reproducible install
- `npm run dev:web` — Fastify API process with watch mode
- `npm run dev:worker` — durable worker process with watch mode
- `npm run dev:ui` — Vite development server
- `npm run check` — formatting, lint, strict typecheck, unit tests, and production builds
- `npm run test:e2e` — Playwright browser smoke test

Copy `.env.example` to `.env` for local overrides. The same build provides separate `web` and `worker` entrypoints; domain modules live under `src/modules` and expose public contracts instead of sharing persistence internals.

Lightweight, API-first, multi-tenant social scheduling and publishing.

Architecture and product implementation begin after the Architect and Designer specifications are accepted through the project kanban loop.
