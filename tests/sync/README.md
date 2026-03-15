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
   node --test tests/sync/braintree-governance.test.js
   node --test tests/sync/democratic.test.js
   node --test tests/sync/conflict.test.js
   node --test tests/sync/fork.test.js
   node --test tests/sync/gossip.test.js
   node --test tests/sync/governance.test.js
   node --test tests/sync/leave-removal.test.js
   node --test tests/sync/merkle.test.js
   node --test tests/sync/vote-propagation.test.js
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

### Gossip (a ↔ b)
- Verify that a sync trigger causes A to push its `instanceLabel` to B (self-announce piggyback)
- Verify that B's current `instanceLabel` appears in A's member view after a sync trigger (self-record in response)
- Verify gossip poisoning: a member cannot overwrite another member's record

### Vote propagation (a ↔ b)
- `GET /api/sync/networks/:id/votes` returns open rounds (auth required)
- Sensitive fields (`inviteKeyHash`, `pendingMember.tokenHash`) are stripped from GET responses
- `POST /api/sync/networks/:id/votes/:roundId` returns 400 missing fields, 404 unknown round, 401 unauthenticated; 200 on valid relay
- After B triggers sync with A, B adopts any open round A has that B does not yet have
- After B triggers sync with A, B merges A's vote casts into the adopted round
- After A triggers sync with B, A merges B's vote casts into the shared round
- A round concludes locally once all remote voters have cast yes (unanimous types) or threshold is met

### Conflict
- Write the same memory ID on A and B simultaneously (requires manual seq injection)
- Sync A→B; verify fork exists on B
- Resolve fork on B; verify resolution

### Leave and removal flows (a ↔ b)
- `DELETE /api/networks/:id` requires auth (401 without token)
- `DELETE /api/networks/:id` removes the network locally (204 + 404 on re-GET) and broadcasts `member_departed` to peers
- After A leaves a network with B, B receives and processes the `member_departed` event — A is removed from B's member list
- `member_departed` is idempotent: sending it for an unknown/already-removed instanceId returns 204
- After a remove vote passes, the ejected instance (B) adds the networkId to `ejectedFromNetworks` and removes the network locally
- Subsequent sync (`POST /api/sync/...`) and vote requests for the ejected networkId return `401 {"error":"ejected"}`
- `member_removed` is idempotent (204 or 404, never 5xx)

### Governance (a)
- Governed `DELETE /api/spaces/:id` on a networked space opens a vote round (202) instead of deleting immediately
- The space remains accessible while the vote is pending
- A yes vote on a solo-member network concludes the round and deletes the space
- A veto concludes the round but the space survives
- N-7 auto-adopt: when a `member_departed` event is received for a braintree member, its children are automatically re-parented to the receiving instance
- Auto-adopt is idempotent: a second departure notify with no orphans is a no-op

### Braintree governance (a + b)
- Root adding a direct child auto-concludes (single ancestor path) → 201
- Intermediate node adding a grandchild opens a two-voter round (`requiredVoters = [B, A]`); B auto-votes; A must vote yes to pass
- An ancestor veto immediately fails the round regardless of other votes
- Root removing its direct child: single ancestor path → immediate 204

### Fork / off-grid (a)
- Fork an active network → 201, new network with same spaces, no members, source unchanged
- Fork a voluntarily-deleted network with `spaces` in body → 201
- Fork a voluntarily-deleted network with no `spaces` → 400
- Fork after ejection (`member_removed`) with `spaces` in body → 201; original id stays in `ejectedFromNetworks`
- Fork after ejection with no `spaces` → 400
- Unknown network id (not ejected) → 404
- Body with an unknown space id → 400
- `type` defaults to `closed`; caller may override to `club`

### Merkle integrity (a ↔ b)
- `GET /api/sync/merkle` on an empty space returns the empty-tree sentinel root
- Root is a 64-char hex SHA-256 string
- Adding a document changes the root
- Two instances with the same data converge to the same root after sync
- Two instances with diverging data have different roots
- A network created with `merkle: true` runs a Merkle comparison on each sync cycle
- Missing `spaceId` → 400; inaccessible space → 403

## Directory layout

```
tests/sync/
  README.md                      — this file
  setup.js                       — first-run setup helper (creates configs/)
  helpers.js                     — shared fetch helpers
  braintree.test.js
  braintree-governance.test.js
  closed-network.test.js
  conflict.test.js
  democratic.test.js
  fork.test.js
  gossip.test.js
  governance.test.js
  leave-removal.test.js
  merkle.test.js
  vote-propagation.test.js
  configs/
    a/                           — populated by setup.js
    b/
    c/
```
