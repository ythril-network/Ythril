# ythril Network Types

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
| **Open** | Automatic | — | None |

> **Open** networks are excluded from v1 — included here for completeness only.

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
        N1net["Network 1"] -.-> Agg["Brain: Agg"]
        N2net["Network 2"] -.-> Agg
        N3net["Network 3"] -.-> Agg
    end
```

The **aggregator** pattern: a single brain joins multiple separate networks as a leaf. It receives data from all of them; `recall` on the aggregator searches across everything locally. No directional config needed — multi-network membership is sufficient.

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
