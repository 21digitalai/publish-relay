# Release checklist

Every release candidate must have one exact commit and reproducible evidence:

- clean checkout; `npm ci` succeeds with the committed lockfile
- `npm run check` passes on Node 24
- credential-free fake-provider browser tests pass
- fresh PostgreSQL migration and authority bootstrap pass
- web and worker start with provider credentials absent; readiness passes
- local backup capture and isolated restore drill pass
- `npm audit --omit=dev` and the committed CycloneDX SBOM are reviewed
- secret, private-data, and customer-identifier scans return no findings
- license, third-party notices, security policy, and contribution docs are present
- upgrade/rollback compatibility is recorded against the previous release
- production dependency installation preserves the reviewed `dist` artifact
- the service account can read the complete normalized release tree
- activation failure restores and smokes the prior release, while uncertain recovery preserves evidence
- the exact single-release lifecycle tests pass, including lock, cleanup, and rollback refusal paths

Repository visibility, package publication, live provider credentials, and external launch
communications are separate owner-authorized actions. A release candidate does not grant
authority for any of them.
