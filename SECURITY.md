# Security Policy

## Supported Versions

Only the latest released version of Ythril receives security fixes.

| Version | Supported |
|---------|-----------|
| 1.x (latest) | ✅ |
| < 1.0 | ❌ |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately via [GitHub Security Advisories](https://github.com/ythril-network/ythril/security/advisories/new).

Please include:

- A clear description of the vulnerability and its impact
- Steps to reproduce or a proof-of-concept (even a rough one)
- The version(s) affected
- Any suggested mitigations, if you have them

## Response Timeline

| Stage | Target |
|-------|--------|
| Acknowledgement | Within 72 hours |
| Initial assessment | Within 7 days |
| Fix or mitigation | Depends on severity (see below) |
| Public disclosure | After fix is released, coordinated with reporter |

**Severity-based fix target:**

| Severity | Target |
|----------|--------|
| Critical (CVSS ≥ 9.0) | 7 days |
| High (CVSS 7.0–8.9) | 14 days |
| Medium (CVSS 4.0–6.9) | 30 days |
| Low (CVSS < 4.0) | Next scheduled release |

## Scope

The following are in scope:

- Authentication and authorisation bypass (PAT, OIDC, sync tokens)
- Injection attacks (MongoDB query injection, path traversal, SSRF)
- Data exfiltration across space boundaries
- Privilege escalation (read-only → write, member → admin)
- Sync network security (invite-replay, direction-enforcement bypass, vote forgery)
- MCP tool security (space boundary violations, prompt injection vectors)
- Container escape or host-filesystem access via the API

The following are **out of scope**:

- Vulnerabilities in third-party dependencies that have no Ythril-specific exploit path
- Attacks requiring physical access to the host
- Social engineering
- Self-XSS or issues only exploitable by an already-authenticated admin

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will publish a security advisory on GitHub. We credit reporters by name (or handle) in the advisory unless you request anonymity.
