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
- Generated a CycloneDX 1.5 npm SBOM for the complete installed dependency graph at `docs/public-core-g1-sbom.cdx.json` (402,155 bytes; 321 components). It is private audit evidence; G2 must regenerate the public copy after dependency remediation and extraction.
- Ran `npm audit --omit=dev --json`: one high aggregate production finding on `@fastify/static` (`<=10.1.1`), including path-traversal advisories. The available fix is `10.1.3` and is a semver-major move from the current declared range.
- Ran `npm run check`: formatting, lint, typecheck, 59 test files/417 tests, and production build passed; 1 file and 2 tests were skipped.

Captured local evidence (not part of the public tree):

- `local-operations/tool-runs/20260911-122701-publish-relay-g1-paths.log`
- `local-operations/tool-runs/20260911-122713-publish-relay-g1-content.log`
- `local-operations/tool-runs/20260911-122713-publish-relay-g1-secret-patterns.log`
- `local-operations/tool-runs/20260911-122737-publish-relay-g1-npm-audit.log`
- `local-operations/tool-runs/20260911-122752-publish-relay-g1-history-identifiers.log`
- `local-operations/tool-runs/20260911-122840-publish-relay-g1-npm-check.log`

Committed private evidence:

- `docs/public-core-g1-sbom.cdx.json` — complete CycloneDX dependency/component graph.
- `docs/public-core-g1-public-manifest.txt` — exact 209-path candidate public tree at the audited baseline. Paths in the manifest are candidates, not proof that their current contents have completed the required neutralization.

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

## Finding reconciliation ledger

Every row produced by the bounded G1 scans is covered by one of these dispositions. There are no unclassified rows in the captured G1 evidence.

| Scan family                                       | Classification                        | Reconciliation                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High-confidence credential/private-key signatures | False positive / clear                | Zero rows in `20260911-122713-publish-relay-g1-secret-patterns.log`; repeat with a dedicated scanner against the extracted history before visibility changes.           |
| Social God and Postiz paths/content               | Block                                 | Omit the parity entrypoints/module/test and sanitize the three library guides plus package scripts. Historical occurrences force a clean root.                          |
| X remediation and legacy credential import        | Block                                 | Omit the listed entrypoints, modules, tests, and migrations; historical occurrences force a clean root.                                                                 |
| Open Clips / `open-clips` / `open_clips`          | Fix                                   | Preserve generic delegated authorization, but neutralize named fixtures, docs, discovery metadata, tests, journal metadata, and the named development-client migration. |
| Daily Viber / `daily-viber` / `daily_viber`       | Fix or block by owner                 | Omit occurrences inside remediation/customer modules; replace occurrences in otherwise-generic tests and fixtures with invented examples.                               |
| Mira                                              | Fix                                   | Replace the three synthetic test labels with neutral account names.                                                                                                     |
| `plamen`                                          | False positive                        | The only current-tree row is a substring in `src/ui/main.tsx`, not an operator identity.                                                                                |
| Package-lock email-shaped and author metadata     | False positive                        | Upstream package metadata, not customer PII; retained only through the lockfile and represented in the SBOM.                                                            |
| Product-generic host/service defaults             | False positive                        | `/opt/publish-relay`, `/etc/publish-relay`, loopback addresses, service users, and database roles are reusable self-host defaults.                                      |
| UUID/email-shaped values in tests                 | Fix/false positive pending row review | Treat synthetic values as false positives only after G2 reviews each occurrence; replace any named/customer-shaped fixture before copying.                              |

## Dependency notices and name-use classification

The SBOM is the package-level inventory. MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, and BlueOak packages require preservation of their applicable copyright/license notices in generated third-party notices; G2 must generate that file from the extracted lockfile rather than hand-maintain a count summary.

| Component/name                                          | Path/evidence                                                   | Classification | Required action                                                                                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `argparse@2.0.1` / Python-2.0                           | `package-lock.json`; SBOM component `argparse@2.0.1`            | Fix            | Include the Python-2.0 license text and attribution in generated third-party notices. Development-only status does not remove redistribution obligations when bundled tooling is distributed. |
| `caniuse-lite@1.0.30001810` / CC-BY-4.0                 | `package-lock.json`; SBOM component `caniuse-lite@1.0.30001810` | Fix            | Include CC-BY-4.0 attribution, title/package name, source URL, license link/text, and indicate unmodified redistribution unless G2 changes it.                                                |
| X name and marks                                        | generic X adapter, OAuth/UI/docs/tests                          | Fix            | Use only descriptive compatibility statements; no affiliation/endorsement claim or X logo asset. Provider API terms remain a runtime/integration obligation, not a Core-code license.         |
| YouTube and Google names/marks                          | YouTube adapter, OAuth/UI/docs/tests                            | Fix            | Use descriptive compatibility statements, preserve provider-required attribution where applicable, and do not bundle Google/YouTube logos or imply endorsement.                               |
| Fastify name                                            | dependencies and backend documentation                          | False positive | Factual framework identification is acceptable; do not use Fastify branding as Publish Relay branding or imply endorsement. Security advisory remains a separate blocking dependency fix.     |
| Node.js, PostgreSQL, Vite, and other tool/project names | root configuration, docs, deploy assets                         | False positive | Factual technical references are acceptable; do not import logos/marks or imply sponsorship. Their package/license notices remain governed by the SBOM-derived notice file.                   |

## Exact private extraction set

The proposed exact private destination is a separate private repository, `https://github.com/21digitalai/publish-relay-private`, preserving the current full-source history with immutable tag `pre-public-core-94d42aa` and owning the following units under their current relative paths on its default branch. This destination is a G2 prerequisite requiring Overseer/operator confirmation and repository creation; until confirmed, extraction remains blocked. The current private `21digitalai/publish-relay` repository must not be treated as the private destination because its intended end state is the sanitized public Core.

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
- `docs/public-core-g1-sbom.cdx.json`
- `docs/public-core-g1-public-manifest.txt`

Also remove the `parity:social-god`, `schedule:social-god`, and remediation/import package scripts and sanitize the associated sections in `library/BACKEND-GUIDE.md`, `library/PRODUCT-GUIDE.md`, and `library/STYLE-GUIDE.md`.

## Fix or inspect before copying

- Replace named Daily Viber, Mira, Postiz, Social God, and Open Clips labels in otherwise-generic tests with neutral tenant/account/client fixtures. UUIDs and emails in tests are predominantly synthetic, but G2 must review each occurrence rather than copying them on shape alone.
- `tests/fixtures/x-identity-oauth1.json` and `tests/fixtures/x-lookup-oauth1.json` contain named account fixtures. Replace with invented provider-neutral/X example identities and prove no production ID remains.
- Preserve generic delegated authorization modules and tests after neutralizing the initial client name; the protocol is Core functionality.
- Preserve generic X adapter, OAuth, media staging/dispatch, scheduler, identity, tenancy, policy, content/media, API, CLI, UI, YouTube adapter, migrations, and host-neutral Linux deploy/backup/restore assets, subject to the final scans and license/security fixes.
- Inspect package-lock email-shaped matches as package metadata; do not treat them as customer PII. The `plamen` match in `src/ui/main.tsx` is a substring false positive, not an operator-name reference.
- `/opt/publish-relay`, `/etc/publish-relay`, loopback addresses, service-user names, and database role names are product-generic defaults. They are allowed unless G2 introduces a customer host/domain/account value.

## Candidate public tree

`docs/public-core-g1-public-manifest.txt` is the exact 209-path include manifest from the audited baseline. The candidate is a clean-history repository containing precisely those paths after applying the required content neutralizations. It includes the modular monolith source, API/agent discovery assets, generic provider adapters, tests, library guides, root README/configuration, and host-neutral deployment examples. Current `migrations/meta/*` is deliberately absent because it encodes the private migration lineage; G2 must generate a fresh public migration lineage and add only its newly generated metadata. It excludes all customer parity, customer remediation/cutover, credential import, named client registration, operator tooling, private evidence, and commercial/hosted composition.

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
