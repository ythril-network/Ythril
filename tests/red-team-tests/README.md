# Red-Team Tests

Security hardening tests that simulate common attacker techniques against a live Ythril instance running in Docker.

> **Scope:** These tests attack only the running Docker containers (HTTP API surface). Source code is NOT modified. Test files are read-only probes.

## Prerequisites

All three Docker containers must be running (use the test compose file, not the
default one — the test stack starts three independent instances each with its own
MongoDB):

```sh
docker compose -f docker-compose.test.yml up --build -d
# or
docker ps   # verify ythril-a, ythril-b, ythril-c are Up
```

Token files must exist (from `tests/sync/setup.js`):

```
tests/sync/configs/a/token.txt
tests/sync/configs/b/token.txt
tests/sync/configs/c/token.txt
```

## Running the tests

```sh
# Run all red-team tests
node --test tests/red-team-tests/*.test.js

# Run a specific attack category
node --test tests/red-team-tests/auth-bypass.test.js
node --test tests/red-team-tests/path-traversal.test.js
node --test tests/red-team-tests/space-boundary.test.js
node --test tests/red-team-tests/mongodb-injection.test.js
node --test tests/red-team-tests/oversized-payload.test.js
node --test tests/red-team-tests/invite-replay.test.js
node --test tests/red-team-tests/token-brute-force.test.js
node --test tests/red-team-tests/ssrf-network-member.test.js
node --test tests/red-team-tests/sync-scope-bypass.test.js
node --test tests/red-team-tests/mass-assignment.test.js
```

> **Note:** `token-brute-force.test.js` exhausts the `authRateLimit` window on instance B. Run it in isolation or after other tests complete.

## Test files

| File | Attack category | What it tests |
|------|----------------|---------------|
| `auth-bypass.test.js` | Authentication | Missing auth, wrong scheme, invalid token, cross-instance token rejection, SQL/NoSQL in token |
| `path-traversal.test.js` | Path traversal | `../` sequences, URL encoding, double-encoding, null bytes, Unicode normalization, absolute paths |
| `space-boundary.test.js` | Access control | Space-scoped tokens cannot access other spaces, boundary enforced on files and brain APIs |
| `mongodb-injection.test.js` | Injection | `$where`, `$gt`, `$ne`, `$regex` operators in JSON body fields; prototype pollution |
| `oversized-payload.test.js` | DoS / resource exhaustion | JSON body size limits, Zod field length validation, array bombs, deep nesting |
| `invite-replay.test.js` | Session security | Replay of consumed handshake, garbage ciphertext in finalize, non-existent IDs |
| `token-brute-force.test.js` | Brute force | Rate limiter stops token enumeration; unauthenticated endpoint rate limiting |
| `ssrf-network-member.test.js` | SSRF | Peer URL registration rejects private IPs (RFC-1918, loopback, link-local), cloud metadata endpoints (AWS/Azure/GCP IMDS), non-http(s) schemes, and embedded credentials |
| `sync-scope-bypass.test.js` | Access control | Space-scoped tokens are blocked from all sync endpoints (GET, POST, batch-upsert, tombstones, manifest) for spaces outside their allowlist |
| `mass-assignment.test.js` | Mass assignment / input validation | Server-generated fields (token id, hash) cannot be injected by the client; `builtIn` flag is not injectable on spaces; Zod strips unknown fields; duplicate JSON keys and oversized inputs are handled safely |

## Expected outcomes

All tests should show **PASS** — meaning all attacker payloads were correctly rejected (4xx responses, never 5xx or 2xx).

If a test fails, it indicates a regression in a security control and must be treated as a **security issue** requiring immediate remediation.

## ISO 27001 alignment

These tests support the following ISO 27001 Annex A controls:

- **A.9** – Access Control (auth bypass, space boundary, token scoping)
- **A.12** – Operations Security (rate limiting, DoS/resource exhaustion)
- **A.14** – System Acquisition, Development and Maintenance (injection hardening, path traversal)
- **A.16** – Information Security Incident Management (regression detection via automated testing)
