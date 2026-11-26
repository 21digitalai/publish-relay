# Repository operating instructions

`main` is the canonical integration and release branch. Develop on temporary feature/fix branches, review the exact combined changes, then merge into `main`. Do not create a separate standing production branch or tell an installation to update before the required changes are in `main`.

Before installing or updating a running instance, read [README.md](README.md) and the canonical [deployment procedure](deploy/README.md). Follow that procedure for the actual installation topology. A Git pull only updates source; it is not a build, database migration, service restart, or successful deployment.

Use the documented guarded deployment lifecycle, including its database authority, backup/recovery and verification requirements. Do not replace it with ad-hoc SQL or assume a different host topology follows the same commands. Keep credentials outside source control.

Report source updated, application deployed, database migrated and live behavior verified as distinct facts. Do not claim success from a branch pull or a healthy old process. Verify that the running version/API actually contains the requested capability.
