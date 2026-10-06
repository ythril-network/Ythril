# Red-Team Tests

Security hardening tests that simulate common attacker techniques against a live Ythril instance running in Docker.

> **Scope:** These tests attack only the running Docker containers (HTTP API surface). Source code is NOT modified. Test files are read-only probes.

## Prerequisites

The Docker containers must be running (use the test compose file, not the default one — the test stack starts independent
instances each with its own MongoDB):

```sh
docker compose -p ythril-test -f testing/docker-compose.test.yml up --build -d
# or
docker ps   # verify the ythril-<letter> containers are Up
```

`npm run test:up` does the same and provisions the tokens. Token files must exist (from `testing/sync/setup.js`):

```
testing/sync/configs/<letter>/token.txt
```

for each instance the tests use; a test that needs one says so in its header.

## Running the tests

```sh
# Run all red-team tests
npm run test:redteam

# Run one attack category
node --test testing/red-team-tests/<file>.test.js
```

`npm run test:redteam` selects the tracked test files in this folder, one at a time, and records their timings in
`test-results/`. `docs/testing-guide.md` says how a new test file reaches CI.

> **Note:** `token-brute-force.test.js` exhausts the `authRateLimit` window on instance B. Run it in isolation or after other tests complete.

## Test files

Every `*.test.js` directly in this folder is an attack category, and each file's header says what it attacks and what
must be rejected. This README does not tabulate them: `git ls-files 'testing/red-team-tests/*.test.js'` is the list.

## Expected outcomes

All tests should show **PASS** — meaning all attacker payloads were correctly rejected (4xx responses, never 5xx or 2xx).

If a test fails, it indicates a regression in a security control and must be treated as a **security issue** requiring immediate remediation.

## ISO 27001 alignment

These tests support the following ISO 27001 Annex A controls:

- **A.9** – Access Control (auth bypass, space boundary, token scoping)
- **A.12** – Operations Security (rate limiting, DoS/resource exhaustion)
- **A.14** – System Acquisition, Development and Maintenance (injection hardening, path traversal)
- **A.16** – Information Security Incident Management (regression detection via automated testing)
