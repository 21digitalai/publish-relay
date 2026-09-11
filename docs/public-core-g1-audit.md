# Publish Relay public Core G1 audit

Date: 2026-09-11  
Audited private commit: `94d42aa4bfed03b0c9616f6a2ee91249d78a74c9`  
Disposition: **blocked from public extraction until the fixes below are applied and re-scanned**

This report records paths and classifications only. It intentionally contains no credential values, customer data, or live account identifiers. It is a private extraction input and must not itself be copied into the public Core tree.

## Scope and evidence

- Audited all 256 files at `HEAD` and all 305 reachable commits.
- Scanned the current tree and every reachable revision for common private-key and high-confidence token signatures. No matching path was found. This is a useful negative signal, not a substitute for a final dedicated secret scanner before publication.
- Searched current and historical content for Social God, Postiz, Open Clips, Daily Viber, operator/organization names, UUID-shaped identifiers, email-shaped identifiers, credential-oriented filenames, and host/deploy paths.
- Reviewed `package.json` and lockfile license metadata. The lockfile reports 372 MIT, 22 Apache-2.0, 20 ISC, 9 BlueOak-1.0.0, 9 BSD-3-Clause, 6 BSD-2-Clause, 1 Python-2.0, and 1 CC-BY-4.0 package records.
- Ran `npm audit --omit=dev --json`: one high aggregate production finding on `@fastify/static` (`<=10.1.1`), including path-traversal advisories. The available fix is `10.1.3` and is a semver-major move from the current declared range.
- Ran `npm run check`: formatting, lint, typecheck, 59 test files/417 tests, and production build passed; 1 file and 2 tests were skipped.

Captured local evidence (not part of the public tree):

- `local-operations/tool-runs/20260911-122701-publish-relay-g1-paths.log`
- `local-operations/tool-runs/20260911-122713-publish-relay-g1-content.log`
- `local-operations/tool-runs/20260911-122713-publish-relay-g1-secret-patterns.log`
- `local-operations/tool-runs/20260911-122737-publish-relay-g1-npm-audit.log`
- `local-operations/tool-runs/20260911-122752-publish-relay-g1-history-identifiers.log`
- `local-operations/tool-runs/20260911-122840-publish-relay-g1-npm-check.log`

## Blocking findings

| Finding                                                                                                                                                                        | Classification | Required G2 action                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The private Git history contains customer-specific and integration-specific paths and text.                                                                                    | Block          | Build the public Core from a new sanitized root/history. Never change repository visibility or publish the current history.                                                                      |
| Root `package.json` has no license field and the repository has no root `LICENSE` or third-party notices file. Apache-2.0 remains a recommendation, not an approved selection. | Block          | Obtain the operator's explicit license decision, then add the selected license metadata/text and generated third-party notices.                                                                  |
| Production dependency audit reports a high finding on `@fastify/static`.                                                                                                       | Block          | Upgrade to a non-vulnerable compatible release, run the full check, and repeat the production audit.                                                                                             |
| Social God/Postiz parity and scheduling code is embedded in the application tree and package scripts.                                                                          | Block          | Move the files listed below to a private companion destination and remove the scripts/references from Core.                                                                                      |
| X remediation and legacy credential migration are customer/cutover operations, including dedicated schema history.                                                             | Block          | Keep these modules, entrypoints, tests, and migrations private. Create a clean Core migration lineage that omits their tables without renumbering already-published private migrations in place. |
| Open Clips is named in a development-client data migration, docs, fixtures, and tests.                                                                                         | Fix            | Retain generic delegated authorization, but move named client registration to the private/client repo or replace it with a neutral example fixture and migration in the clean lineage.           |
| The macOS local launcher embeds Nexus Vault logical credential names and machine-specific Homebrew/launchd assumptions.                                                        | Block          | Keep `deploy/macos/publish-relay-local.sh` private. Core may retain only host-neutral deployment examples with placeholder secret injection.                                                     |
| Current report and private extraction evidence name private boundaries.                                                                                                        | Block          | Exclude this report and all `local-operations` evidence from the public tree.                                                                                                                    |

## Exact private extraction set

Move or omit these current paths as units, including their imports, scripts, documentation paragraphs, snapshots, and test references:

- `src/entrypoints/social-god-parity.ts`
- `src/entrypoints/social-god-schedule.ts`
- `src/modules/parity/social-god.ts`
- `tests/social-god-parity.test.ts`
- `src/entrypoints/x-remediation.ts`
- `src/modules/providers/x-remediation-dispatch.service.ts`
- `src/modules/providers/x-remediation.repository.ts`
- `src/modules/providers/x-remediation.service.ts`
- `tests/x-remediation-dispatch.test.ts`
- `tests/x-remediation.repository.integration.test.ts`
- `tests/x-remediation.test.ts`
- `migrations/0020_x_remediation_journal.sql`
- `migrations/0021_x_remediation_started_phases.sql`
- `src/entrypoints/import-legacy-x-credential.ts`
- `src/modules/providers/x-legacy-credential-import.ts`
- `tests/x-legacy-credential-import.test.ts`
- `migrations/0033_open_clips_development_client.sql` (named registration only; retain generic delegated authorization schema)
- `deploy/macos/publish-relay-local.sh`
- `docs/public-core-g1-audit.md`

Also remove the `parity:social-god`, `schedule:social-god`, and remediation/import package scripts and sanitize the associated sections in `library/BACKEND-GUIDE.md`, `library/PRODUCT-GUIDE.md`, and `library/STYLE-GUIDE.md`.

## Fix or inspect before copying

- Replace named Daily Viber, Mira, Postiz, Social God, and Open Clips labels in otherwise-generic tests with neutral tenant/account/client fixtures. UUIDs and emails in tests are predominantly synthetic, but G2 must review each occurrence rather than copying them on shape alone.
- `tests/fixtures/x-identity-oauth1.json` and `tests/fixtures/x-lookup-oauth1.json` contain named account fixtures. Replace with invented provider-neutral/X example identities and prove no production ID remains.
- Preserve generic delegated authorization modules and tests after neutralizing the initial client name; the protocol is Core functionality.
- Preserve generic X adapter, OAuth, media staging/dispatch, scheduler, identity, tenancy, policy, content/media, API, CLI, UI, YouTube adapter, migrations, and host-neutral Linux deploy/backup/restore assets, subject to the final scans and license/security fixes.
- Inspect package-lock email-shaped matches as package metadata; do not treat them as customer PII. The `plamen` match in `src/ui/main.tsx` is a substring false positive, not an operator-name reference.
- `/opt/publish-relay`, `/etc/publish-relay`, loopback addresses, service-user names, and database role names are product-generic defaults. They are allowed unless G2 introduces a customer host/domain/account value.

## Candidate public tree

The candidate is a clean-history repository containing the generic files at this audited commit after applying the omissions and neutralizations above. It includes the modular monolith source, generic migrations reconstructed into a fresh public lineage, API/agent discovery assets, generic provider adapters, tests, library guides, root README/configuration, and host-neutral deployment examples. It excludes all customer parity, customer remediation/cutover, credential import, named client registration, operator tooling, private evidence, and commercial/hosted composition.

## G2 acceptance gate

Before any review or visibility change, G2 must provide one commit that proves:

1. clean-root extraction with no private history;
2. explicit approved license plus third-party notices;
3. no customer/remediation/legacy-import/named-client artifacts or package scripts;
4. high-confidence secret scan and customer/account/host identifier scan with zero unresolved findings;
5. `npm audit --omit=dev` with no high/critical finding;
6. module-boundary tests and full `npm run check` passing;
7. exact rollback source commit and private destination for every omitted unit.

No repository visibility, publishing, deployment, provider action, account migration, or license selection is authorized by this audit.
