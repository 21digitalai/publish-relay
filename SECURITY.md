# Security policy

Please report suspected vulnerabilities privately through GitHub Security Advisories for
this repository. Do not open a public issue containing exploit details, credentials, private
data, or provider tokens.

Include the affected commit/version, impact, reproduction steps, and any suggested mitigation.
Maintainers will acknowledge a complete report within seven calendar days and coordinate a
fix and disclosure timeline based on severity. Do not test against systems or accounts you do
not own or have explicit authorization to assess.

Supported security fixes target the latest released version. Self-hosters should keep Node.js,
PostgreSQL, and system packages patched, isolate `/metrics`, use TLS, preserve separate database
authorities, and store all secrets outside the repository. Never paste secrets into issues,
logs, screenshots, or support messages.
