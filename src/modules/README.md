# Module boundary

Each domain owns `domain`, `application`, and `infrastructure` internals and exposes cross-module behavior through its root public contract. Modules must never import another module's `infrastructure` directory. Transport and UI call application use-cases; infrastructure implements domain ports.

Planned domains: identity, workspaces, credentials, accounts, content, media, scheduling, providers, audit, and operations.
