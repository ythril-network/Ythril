# Ythril Sync Integration Tests

## Prerequisites

1. Build and start the test stack:
   ```
   docker compose -f docker-compose.test.yml up --build -d
   ```
   Wait until all 6 containers are healthy (~30-45 seconds first run).

2. Run setup on each instance (one-time, creates configs in `tests/sync/configs/`):
   ```
   node tests/sync/setup.js
   ```
   This will:
   - Complete the first-run setup on each instance
   - Create a PAT on each instance
   - Create a `general` space on each
   - Write the peerTokens into each instance's secrets.json

3. Run the integration tests:
   ```
   node --test tests/sync/closed-network.test.js
   node --test tests/sync/braintree.test.js
   node --test tests/sync/democratic.test.js
   node --test tests/sync/conflict.test.js
   ```
   Or run all:
   ```
   node --test tests/sync/*.test.js
   ```

## Instance URLs

| Instance | Port | Container name |
|----------|------|----------------|
| A        | 3200 | ythril-a       |
| B        | 3201 | ythril-b       |
| C        | 3202 | ythril-c       |

## Scenarios

### Closed network (a ↔ b)
- Create network on A, add B as member
- Write a memory on A; trigger sync; verify B has the memory
- Write a memory on B; trigger sync; verify A has the memory
- Delete a memory on A; verify tombstone propagates to B

### Braintree (a → b → c)
- A is root, B is A's child (direction=push), C is B's child (direction=push)
- Write on A, trigger sync; verify B gets it; trigger sync on B; verify C gets it
- Write on C; trigger sync; verify B does NOT get it (push only)
- Write on B; trigger sync; verify A does NOT get it (push only)

### Democratic (a + b + c)
- Create democratic network with 3 members
- Add B via vote: A votes yes, B votes yes -> passes
- Add C via vote: A votes no (veto) -> fails with veto
- Add C via vote: A yes, B yes, C (self skip) -> passes

### Conflict
- Write the same memory ID on A and B simultaneously (requires manual seq injection)
- Sync A→B; verify fork exists on B
- Resolve fork on B; verify resolution

## Directory layout

```
tests/sync/
  README.md           — this file
  setup.js            — first-run setup helper (creates configs/)
  helpers.js          — shared fetch helpers
  configs/
    a/                — populated by setup.js
    b/
    c/
  closed-network.test.js
  braintree.test.js
  democratic.test.js
  conflict.test.js
```
