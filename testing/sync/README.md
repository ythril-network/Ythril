# Ythril Sync Integration Tests

These tests drive several Ythril instances against each other: network types, governance and voting, conflict handling,
file and record sync, forgery rejection. Every `*.test.js` directly in this folder is part of the suite; each file's
header comment says what it proves. This README does not list them, because a list written by hand is wrong the day a
file is added: `git ls-files 'testing/sync/*.test.js'` is the list, and `docs/testing-guide.md` says how a test file reaches
CI.

## Prerequisites

1. Build and start the test stack:
   ```
   docker compose -p ythril-test -f testing/docker-compose.test.yml up --build -d
   ```
   Wait until the containers are healthy (`docker compose -p ythril-test -f testing/docker-compose.test.yml ps` lists
   them; the first run takes longer). `npm run test:up` does this, then step 3.

2. For repeated local runs, start without rebuild to avoid unnecessary disk growth:
   ```
   docker compose -p ythril-test -f testing/docker-compose.test.yml up -d
   ```

3. Run setup on each instance (one-time, creates configs in `testing/sync/configs/`):
   ```
   node testing/sync/setup.js
   ```
   This will:
   - Complete the first-run setup on each instance
   - Create a PAT on each instance
   - Create a `general` space on each
   - Write the peerTokens into each instance's secrets.json

   Name instances to set up only those (`node testing/sync/setup.js a b`); CI does that for the instances a job starts.

4. Run the sync integration tests:
   ```
   npm run test:sync
   ```
   or one file:
   ```
   node --test testing/sync/<file>.test.js
   ```
   `npm run test:sync` selects the tracked test files in this folder, one at a time (they share one live stack, and run
   together they report false failures), and records their timings in `test-results/`.

5. Mandatory cleanup after heavy or repeated runs:
   ```
   docker compose -p ythril-test -f testing/docker-compose.test.yml down -v --rmi local --remove-orphans
   docker builder prune --reserved-space 3g --force
   docker image prune -f
   docker volume prune -f
   ```

## QA policy for high-volume tests

- High-volume tests are intentionally retained for regression and scalability coverage.
- Every high-volume test must either:
  - run in a disposable test space that is deleted in `after()`; or
  - wipe created data in teardown with explicit API cleanup.
- Shared long-lived spaces (such as `general`) should not be used for bulk seeding tests unless teardown is guaranteed in the same file.

## Full suite runner behavior

- `npm run test:all` now performs mandatory post-run cleanup (`test:down:clean`) even when tests fail.
- Use `npm run test:all:keep` only when you explicitly need the environment left running for debugging.

## Instances

The instances are the `ythril-<letter>` services of `testing/docker-compose.test.yml`; each publishes its own port there
(`ports:` of the service), and `testing/sync/configs/<letter>/` holds what `setup.js` wrote for it. The topology a test
needs (closed network, braintree, democratic) is built by the test itself through the API.

## Directory layout

- `setup.js` — first-run setup helper; creates `configs/`
- `helpers.js` — shared fetch and wait helpers
- `*.test.js` — the suite, one scenario family per file
- `configs/<letter>/` — populated by `setup.js`, not tracked
