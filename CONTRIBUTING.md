# Contributing

Contributions are welcome for the open-source Core. Keep changes provider-neutral and do not
add hosted billing, plans, private customer operations, credentials, live account identifiers,
or unsupported provider claims.

1. Open an issue for material product, architecture, data-model, or security changes.
2. Create a focused branch from the current default branch.
3. Run `npm ci` and `npm run check` on Node 24.
4. Add behavior-focused tests and a forward migration for every schema change.
5. Update `library/BACKEND-GUIDE.md` or `library/STYLE-GUIDE.md` when introducing a reusable
   backend or UI pattern.
6. Explain security, tenant-isolation, migration, rollback, and provider-lifecycle effects in
   the pull request.

Do not include generated environment files, database dumps, media, tokens, provider payloads,
or customer data. By submitting a contribution, you agree that it is licensed under
`AGPL-3.0-only`.
