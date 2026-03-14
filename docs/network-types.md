# Ythril Network Types

This document describes how multiple ythril brains interact with each other through networks. A **brain** is one ythril instance. A brain contains one or more **spaces**. Networks connect brains together to sync specific spaces.

---

## Conceptual hierarchy

```mermaid
graph TD
    M["Machine"]
    B1["Brain A (port 3200)"]
    B2["Brain B (port 3201)"]
    S1["Space: general"]
    S2["Space: work"]
    S3["Space: general"]
    N1["Network: Personal Devices"]
    N2["Network: Work Team"]

    M --> B1
    M --> B2
    B1 --> S1
    B1 --> S2
    B2 --> S3
    N1 -. "syncs general" .-> S1
    N2 -. "syncs work" .-> S2
```

A brain's spaces are isolated from each other. A network is scoped to specific spaces — it syncs only those, leaving all others private.

---

## Network types

| Type | Who approves joins | Who approves removals | Veto |
|------|-------------------|-----------------------|------|
| **Closed** | All members (unanimous) | All members (unanimous) | Implicit — any no = fail |
| **Democratic** | ≥ 50% + zero vetoes | ≥ 50% + zero vetoes | Explicit — any member may veto |
| **Club** | The member who issued the key | The member who proposed removal | None |
| **Braintree** | All ancestors from inviter to root | All ancestors from target to root | Implicit per ancestor |
| ~~**Open**~~ | Automatic | — | None — **excluded from v1; not implemented** |

---

## Closed network

All members must vote yes for any join or removal. A single no blocks it. For a solo member (one device), every action is instant self-approval.

```mermaid
graph LR
    A["Brain A\n(server)"]
    B["Brain B\n(laptop)"]
    C["Brain C\n(NAS)"]

    A <-->|"sync: general"| B
    B <-->|"sync: general"| C
    A <-->|"sync: general"| C

    style A fill:#1a3a5c,color:#eee,stroke:#4488cc
    style B fill:#1a3a5c,color:#eee,stroke:#4488cc
    style C fill:#1a3a5c,color:#eee,stroke:#4488cc
```

**Join vote — candidate D wants to join:**

```mermaid
sequenceDiagram
    participant D as Brain D (candidate)
    participant A as Brain A
    participant B as Brain B
    participant C as Brain C

    D->>A: POST /api/networks/:id/join  (invite key)
    A-->>A: opens voting round
    A-->>B: gossip: vote pending
    A-->>C: gossip: vote pending
    B->>A: yes
    C->>A: yes
    A->>A: pass → add D to member list
    A-->>D: member list + sync starts
```

Any member voting **no** → round fails, key consumed, D not added.

---

## Democratic network

Majority (≥50%) is enough — but any single member can cast an explicit **veto** to block the outcome regardless of count. Suited to collaborative groups where one bad actor cannot be autocratically admitted.

```mermaid
graph LR
    A["Brain A"] <-->|sync| B["Brain B"]
    B <-->|sync| C["Brain C"]
    A <-->|sync| C
    A <-->|sync| D["Brain D"]
    B <-->|sync| D
    C <-->|sync| D

    style A fill:#2a3a1a,color:#eee,stroke:#66aa44
    style B fill:#2a3a1a,color:#eee,stroke:#66aa44
    style C fill:#2a3a1a,color:#eee,stroke:#66aa44
    style D fill:#2a3a1a,color:#eee,stroke:#66aa44
```

**5-member network, join vote (3 yes, 1 no, 1 veto):**

```mermaid
sequenceDiagram
    participant E as Candidate E
    participant Net as Network (5 members)

    E->>Net: join request
    Net-->>Net: voting round opens (48h deadline)
    Note over Net: A → yes<br/>B → yes<br/>C → yes<br/>D → no<br/>F → VETO
    Net-->>E: ✗ blocked by veto — not admitted
```

Result: even though 3 of 5 voted yes, the single veto blocks admission.

---

## Club network

The member who issued the invite key is the sole approver for joins. One member can admit or eject anyone unilaterally. No votes needed from others. Intended for small informal groups where a single trusted organiser manages membership.

```mermaid
graph TD
    O["Organiser (Club owner)"]
    A["Brain A"]
    B["Brain B"]
    C["Brain C"]

    O <-->|sync| A
    O <-->|sync| B
    O <-->|sync| C
    A <-->|sync| B
    A <-->|sync| C
    B <-->|sync| C

    O -- "issues key → D admitted instantly" --> D["Brain D (new)"]

    style O fill:#3a2a1a,color:#eee,stroke:#cc8844
```

No voting round propagated to A, B, or C — organiser's yes is sufficient.

---

## Braintree network

Members form a directed tree. The founder is the root. Data flows **top-down only** — a parent pushes to its children; no data flows back up. Node A and Node B only share what the Root has already received; they have no direct connection to each other. A new leaf is approved by **all ancestors on the path from the inviting node up to the root**. Leaves may leave at any time and go off-grid; the root has no technical ability to prevent this.

If an intermediate node goes offline, its subtree is partitioned until it returns. The grandparent can issue a **reparent invite** so the grandchild temporarily or permanently moves up one level — see [Braintree: temporary and permanent re-parenting](#braintree-temporary-and-permanent-re-parenting).

```mermaid
graph TD
    Root["Root (founder)"]
    A["Node A"]
    B["Node B"]
    A1["Leaf A1"]
    A2["Leaf A2"]
    B1["Leaf B1"]

    Root -->|push| A
    Root -->|push| B
    A -->|push| A1
    A -->|push| A2
    B -->|push| B1

    style Root fill:#3a1a3a,color:#eee,stroke:#aa44cc
    style A    fill:#2a1a3a,color:#eee,stroke:#7744cc
    style B    fill:#2a1a3a,color:#eee,stroke:#7744cc
    style A1   fill:#1a1a2a,color:#eee,stroke:#5544cc
    style A2   fill:#1a1a2a,color:#eee,stroke:#5544cc
    style B1   fill:#1a1a2a,color:#eee,stroke:#5544cc
```

**Joining as a leaf under Node A:**

```mermaid
sequenceDiagram
    participant L as Leaf A3 (candidate)
    participant A as Node A (inviter)
    participant Root as Root

    L->>A: POST /api/networks/:id/join  (key issued by A)
    A-->>Root: gossip: vote pending
    Root->>Root: votes yes
    A->>A: votes yes
    Note over Root,A: both ancestors approved
    A-->>L: admitted — begins syncing with A
    Note over A,L: Node B and B1 are NOT notified
    Note over A,L: and do NOT sync with A3
```

A leaf added under Node A does **not** sync directly with Node B or its subtree — sync only flows along the tree edges.

**Leaf departing and going off-grid:**

```mermaid
sequenceDiagram
    participant A1 as Leaf A1
    participant A as Node A
    participant Root as Root

    A1-->>A: departure gossip: "leaving"
    A-->>Root: gossip relayed
    Note over A1: keeps all data<br/>syncing stops<br/>may found new network
    Root-->>Root: removes A1 from member list
```

> **If A1 does not voluntarily depart but A goes offline**, Root can instead do a reparent invite to reconnect A1 directly. See [Offline peers and silent departure](#offline-peers-and-silent-departure).

## Offline peers and silent departure

### Temporarily offline (vacation scenario)

A peer that is unreachable for a sync cycle is skipped, and the cycle continues for all other members. The `lastSyncAt` timestamp and the `lastSeqReceived` high-water mark are only advanced on a successful sync — so when the peer comes back online, it picks up exactly where it left off, regardless of how long it was gone. All accumulated changes since the last successful sync are exchanged on the next cycle.

Each outbound connection attempt times out after **10 seconds** — a one-month-offline peer causes a 10 s delay per cycle, not the OS TCP timeout (~75 s).

### Consistently unreachable peers

Each failed sync attempt increments `consecutiveFailures` on the member record. After **10 consecutive failures** a prominent warning is written to the log:

```
PEER UNREACHABLE: 'laptop' in network 'Personal Devices' has failed 10 consecutive
sync cycles. Last success: 2026-02-12T09:14:00Z. Member has NOT been removed —
manual action required.
```

The member is **never auto-removed**. Automatic removal from a network requires going through the same governed process as any other removal (unanimous vote for Closed, majority for Democratic, etc.). Silent pruning would violate the governance contract.

If a peer is confirmed gone forever, remove it manually through the network management UI or `DELETE /api/networks/:id/members/:instanceId`. The removal still goes through the vote round for governed network types.

### Braintree: offline intermediate nodes

In a braintree, data flows strictly along tree edges. If an intermediate node (one with children) becomes unreachable:

- The subtree beneath it is **partitioned** — it stops receiving updates from the root for as long as the intermediate node is down.
- The root and sibling subtrees continue syncing normally among themselves.
- When the intermediate node comes back, it catches up first, then pushes the accumulated changes down to its children on its next cycle.

The partition warning in the log identifies this explicitly:

```
PEER UNREACHABLE: 'Node A' ... NOTE: this node has 2 child(ren) in a braintree
network — its entire subtree is now partitioned from this brain until it comes
back online.
```

There is no automatic re-routing around a failed intermediate node. This is by design — routing around a node would mean data bypasses an ancestor that has governance authority over the subtree. If a braintree node permanently departs, the affected leaves must be re-admitted under a different parent.

### Braintree: temporary and permanent re-parenting

When an intermediate node has been offline long enough to trigger the unreachable warning, its parent can initiate a **reparent invite** — the same RSA handshake used for normal joins, but flagged as a reparent so the grandchild is updated in place rather than added as a new member.

**Flow:**

```mermaid
sequenceDiagram
    participant A1 as Leaf A1 (grandchild)
    participant Root as Root (grandparent)
    participant A as Node A (offline)

    Note over A: consecutiveFailures ≥ 10 — subtree partitioned
    Root->>Root: POST /api/invite/generate { networkId, reparentInstanceId: A1 }
    Root-->>A1: handshakeId + Root's RSA-4096 public key (out-of-band)

    A1->>Root: POST /api/invite/apply  (existing-member check bypassed for reparent)
    Root->>Root: creates new PAT for A1, encrypts with A1's public key
    Root-->>A1: { encryptedTokenForA1, Root's public key }

    A1->>Root: POST /api/invite/finalize { encryptedTokenForRoot }
    Root->>Root: decrypts token, updates A1's member record
    Note over Root: A1.parentInstanceId ← Root<br/>A1.originalParentInstanceId ← A

    A1->>A1: POST /api/networks/:id/reparent-self
    Note over A1: temporaryReparent recorded locally<br/>Root added to peerTokens

    Note over A1,Root: Root now pushes directly to A1
```

After finalize, Root's engine includes A1 in its regular push cycle. A1 resumes receiving updates immediately. A1's local `reparent-self` call registers the state for UI display and token storage.

**When A comes back online**, the engine logs:

```
REPARENT_REVERT_AVAILABLE: original parent 'Node A' is back online.
'Leaf A1' was temporarily re-parented during the outage.
To restore:       POST /api/networks/:id/members/A1/revert-parent
To make permanent: POST /api/networks/:id/members/A1/adopt
```

Two options from the Root (grandparent) side:

| Action | Endpoint | Effect |
|--------|----------|--------|
| **Revert** | `POST /api/networks/:id/members/:instanceId/revert-parent` | Restores `A1.parentInstanceId = A`, removes Root's direct push token, moves A1 back to A's `children` array |
| **Permanent adoption** | `POST /api/networks/:id/members/:instanceId/adopt` | Clears `originalParentInstanceId` — Root is now A1's permanent parent |

A1's admin should also update A1's local config:  
- After revert: remove Root from `peerTokens`, clear `temporaryReparent`  
- After adopt: just clear `temporaryReparent`  

(A1 calls neither `revert-parent` nor `adopt` — those run on Root. A1 manages only its own `temporaryReparent` state, which is purely for local display.)

**Governance note:** Node A is still a member of the network when it reconnects. Its `children` array will be updated by the revert or adopt action on Root. If A was permanently offline and you want to remove it entirely, go through the normal member removal process.

---

## RSA invite handshake

Network membership exchange uses a zero-knowledge RSA handshake to avoid passing tokens in plaintext. No token ever appears in clear text over the wire or in a QR code.

### Flow

```mermaid
sequenceDiagram
    participant A as Instance A (inviter)
    participant B as Instance B (joiner)

    Note over A,B: Only URLs and RSA public keys are shared out-of-band
    A->>A: POST /api/invite/generate
    A-->>B: handshakeId + A's RSA-4096 public key (PEM)

    B->>B: generate own RSA-4096 key pair
    B->>A: POST /api/invite/apply { handshakeId, rsaPublicKeyPem(B) }
    A->>A: create PAT for B, encrypt with B's public key
    A-->>B: { encryptedTokenForB, rsaPublicKeyPem(A) }

    B->>B: decrypt tokenForB with B's private key
    B->>B: create PAT for A, encrypt with A's public key
    B->>A: POST /api/invite/finalize { handshakeId, encryptedTokenForA }
    A->>A: decrypt tokenForA with A's private key
    Note over A,B: Both sides can now sync using their respective tokens
```

### Security properties

- **RSA-4096-OAEP-SHA256** keys generated ephemerally per session.
- **Private keys** are held in memory only and discarded immediately after `finalize`.
- **Single-use sessions**: replaying `apply` on the same `handshakeId` returns 409.
- **`handshakeId`** is stored as a bcrypt hash — lookup uses constant-time comparison.
- Sessions expire after 1 hour; any attempt on an expired or unknown session returns 401.
- Rate-limited at the auth tier (10 req/min per IP on `apply` and `finalize`).

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/invite/generate` | Bearer token | Start a session for a specific network |
| `POST` | `/api/invite/apply` | none (handshakeId is credential) | B submits its RSA public key; receives encrypted token |
| `POST` | `/api/invite/finalize` | none (handshakeId is credential) | B delivers encrypted token for A; session completed |
| `GET` | `/api/invite/status/:handshakeId` | none | Check if a session is still pending or completed |

---

## Topologies that fall out naturally

Any communication pattern reduces to tree structure and multi-network membership. No special config is needed.

```mermaid
graph TD
    subgraph "Full mesh (Closed/Democratic)"
        M1 <--> M2
        M2 <--> M3
        M1 <--> M3
    end

    subgraph "Star / pub-sub (Braintree depth=1)"
        Hub -->|push| L1
        Hub -->|push| L2
        Hub -->|push| L3
    end

    subgraph "Chain (Braintree width=1)"
        C1 -->|push| C2 -->|push| C3 -->|push| C4
    end

    subgraph "Aggregator / leech"
        Agg["Brain: Agg"] -.->|member of| N1net["Network 1"]
        Agg -.->|member of| N2net["Network 2"]
        Agg -.->|member of| N3net["Network 3"]
    end
```

The **aggregator** pattern: a single brain joins multiple separate networks as a leaf. It receives data from all of them; `recall` on the aggregator searches across everything locally. No directional config needed — multi-network membership is sufficient.

### Multi-network participation examples

One brain can join several networks at once, each scoped to different spaces.

1. Personal + Team split
- `research` in a Closed network with your own devices
- `team-alpha` in a Democratic network with coworkers
- Result: personal research stays private to your devices while team knowledge stays team-governed

2. Team + Publisher overlay
- `team-alpha` in a Democratic network
- `broadcast` in a Braintree network where your brain is a leaf
- Result: team collaboration continues while your brain also receives one-way parent updates

3. Three-network aggregator
- `research` from network A
- `project-x` from network B
- `archive` from network C
- Result: one local brain can run global recall across all locally synced spaces without introducing a central broker

```mermaid
flowchart TD
    Y[Brain: you]
    N1[Closed network\nspace: research]
    N2[Democratic network\nspace: team-alpha]
    N3[Braintree network\nspace: broadcast]
    Y ---|member| N1
    Y ---|member| N2
    Y -.->|leaf receives push| N3
```

---

## Voting mechanics (all types)

```mermaid
flowchart TD
    A([Invite key issued]) --> B[Candidate presents key\nPOST /api/networks/:id/join]
    B --> C{Valid key?}
    C -- no --> FAIL1([Key rejected])
    C -- yes --> D[Voting round opens\ndeadline starts]
    D --> E[Eligible voters notified\nvia gossip on next sync]
    E --> F{Before deadline}
    F --> G[Members cast yes / veto\nvia Settings → Networks]
    G --> H{Pass conditions met?}
    H -- yes --> PASS([Candidate admitted\nKey consumed\nSync begins])
    H --> I{Deadline reached?}
    I -- yes --> FAIL2([Round dismissed\nKey consumed\nFresh key needed])
    I -- no --> F
    H -- no & not expired --> F
```

---

## Data sovereignty

Regardless of network type:

- **Any member can leave at any time**, unilaterally, without a vote.
- The leaver **keeps all data** on their own machine. This is physically unavoidable and explicitly accepted by all parties when they join.
- **Force-delete does not exist.** There is no mechanism to delete data from another member's instance. Network membership (who syncs with whom) is governable; what someone does with their local copy is not.
- A departed member may found their own new network from their copy of the data.

```mermaid
sequenceDiagram
    participant Leaf as Departing Leaf
    participant Others as Remaining Members

    Leaf-->>Others: gossip: departure
    Others-->>Others: remove Leaf from member list\nstop syncing
    Note over Leaf: local data untouched\nleaf is now independent\nmay found new network or stay solo
```
