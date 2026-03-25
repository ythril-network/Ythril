# Ythril User Guide



Complete reference for installing, configuring, and operating Ythril brains. Covers first-run setup, the web UI, token and space management, data persistence, running multiple brains, and network configuration for syncing spaces across brains.



For network type concepts see [network-types.md](network-types.md).  

For the wire protocol see [sync-protocol.md](sync-protocol.md).



---



## Table of contents



1. [Installation](#installation)

2. [First-run setup](#first-run-setup)

3. [The web UI](#the-web-ui)

4. [Token management](#token-management)

5. [Two-factor authentication (MFA)](#two-factor-authentication-mfa)

6. [Space management](#space-management)

7. [Storage quotas](#storage-quotas)

8. [Running multiple brains](#running-multiple-brains)

9. [Data persistence and recovery](#data-persistence-and-recovery)

10. [Brain networks](#brain-networks)

11. [Creating a network](#creating-a-network)

11. [Inviting another brain](#inviting-another-brain)

12. [Joining a network](#joining-a-network)

13. [Managing members](#managing-members)

14. [Sync schedule](#sync-schedule)

15. [Governance and voting](#governance-and-voting)

16. [Braintree networks](#braintree-networks)

17. [Leaving a network](#leaving-a-network)

18. [Forking a network](#forking-a-network)
19. [Triggering sync manually](#triggering-sync-manually)
20. [Conflict resolution](#conflict-resolution)
21. [Merkle integrity](#merkle-integrity)



---



## Installation



Starting a single brain requires only Docker. No other dependencies.



```bash

docker compose up --build

```



This builds the image and brings up two containers:



| Container | Role |

|-----------|------|

| `ythril` | Brain server — REST API, MCP endpoints, Angular web UI (port 3200) |

| `ythril-mongo` | MongoDB Atlas Local with the `mongot` sidecar required for semantic (`$vectorSearch`) queries |



On first start, MongoDB's replica set needs to elect a primary before the server starts accepting connections. This takes up to about three minutes. The server prints the startup banner when it is ready.



Once running, open `http://localhost:3200` in a browser to complete setup.



On subsequent starts, when the image is already built:



```bash

docker compose up

```



To stop without losing data:



```bash

docker compose down

```



### Startup output

By default the server prints a minimal banner when it is ready — just enough to confirm it started OK.

**First run** (no `config.json` yet):

```
  ythril  ·  first-run setup required

  URL         http://localhost:3200
  Setup code  A1B2-C3D4-E5F6-G7H8
```

The setup code is printed in orange when the terminal supports colour.

**Subsequent starts** (brain already configured):

```
  ythril  ✓ ready  ·  http://localhost:3200
```



To see verbose logs from all subsystems (MongoDB, sync engine, spaces, etc.) pass `DEBUG=1`:



```bash

DEBUG=1 docker compose up

```



---



## First-run setup

On first start, before `config.json` exists, the server generates a one-time setup code and shows it in the startup banner:

```
  ythril  ·  first-run setup required

  URL         http://localhost:3200
  Setup code  A1B2-C3D4-E5F6-G7H8
```

Open `http://localhost:3200`. The setup form asks for:

| Field | Description |
|-------|-------------|
| Setup code | Copy from the startup banner |
| Brain label | Human-readable name for this instance (shown to peers in networks) |



On submit, the server:



1. Creates `config/config.json` and `config/secrets.json` with mode 0600

2. Auto-creates a `general` space

3. Generates your first PAT and displays it **once** — copy it immediately; it cannot be retrieved again



The setup code is single-use and discarded after successful setup. If the container restarts before setup is completed, a new code is generated.



---



## The web UI



Log in with your PAT at `http://localhost:3200`. The left navigation has four sections:



| Section | What it does |

|---------|--------------|

| **Brain** | Store and search memories (semantic recall), manage entities and knowledge-graph edges (with optional `type` classification) |

| **Files** | Browse, upload, download, move, delete files within each space; resolve sync conflicts |

| **Settings** | Token management, space administration, network configuration, storage usage |



Every section is scoped to the spaces your token allows. A token with `spaces: ["eng-kb"]` sees only `eng-kb` throughout the UI; no other space is visible or accessible.



The token is stored in browser `localStorage` under the key `ythril_token`. Logging out clears it.

### Knowledge-graph edges

Edges connect two entities inside a space. Each edge has a `from` entity, a `to` entity, a `label` (the relationship name), an optional numeric `weight`, and an optional `type` string for classification (e.g. `causal`, `hierarchical`, `temporal`).

The `type` field is visible in the **Brain → Edges** table in the UI and is accepted by both the REST API (`POST /api/brain/:spaceId/edges`) and the MCP `upsert_edge` tool. It syncs across networked brains like any other edge field.

---

## Token management



All API and MCP access requires a Bearer PAT (`ythril_` prefix, 32 random bytes, base62-encoded). Tokens are bcrypt-hashed at storage time and never logged or returned in plaintext after creation.



### Admin vs non-admin tokens



Every token carries an **admin** flag:



| Flag | Access |
|------|--------|
| `admin: true` | Full access — token management, space create/delete, all network management |
| `admin: false` | Data-only access — brain, files, MCP, read-only spaces and networks list |



The first token created during setup is always admin. Only an admin token can create further tokens (admin or non-admin). Leaked integration tokens scoped to a space cannot escalate to admin privileges.



### From Settings → Tokens



- **Create** — provide a name, an optional expiry date, an optional space allowlist, and (if your token is admin) an **Admin** checkbox. The plaintext is shown once.

- **Rotate** (↺) — generates a new secret for the token in place. The old plaintext is invalidated immediately; the new one is shown once. Use this for credential rotation without revoking the record.

- **Revoke** (✕) — deletes the token permanently. Any cached verification expires within 5 minutes.



**Space allowlist** — leave empty to grant access to all current and future spaces. Populate to restrict a token to specific spaces:



```json

{

  "name": "claude-desktop",

  "spaces": ["general", "eng-kb"]

}

```



A revoked or expired token gets `401` on all endpoints.



**Connecting an MCP client** (e.g. Claude Desktop):



```json

"ythril-general": {

  "type": "sse",

  "url": "http://localhost:3200/mcp/general",

  "headers": { "Authorization": "Bearer ythril_..." }

}

```



Each space has its own MCP endpoint at `/mcp/{spaceId}`. A single PAT can serve multiple MCP entries if it has access to all required spaces.



---



## Two-factor authentication (MFA)

MFA adds an optional TOTP (time-based one-time password) requirement on top of admin PAT authentication. When enabled, every **admin mutation** — creating or revoking tokens, creating or deleting spaces — must also supply a valid 6-digit code via the `X-TOTP-Code` header. Read-only endpoints and all data-plane (brain, files, MCP) endpoints are unaffected.

MFA is **disabled by default**. It is enabled and managed from **Settings → MFA** in the web UI.



### Enrolling

1. Open **Settings → MFA** and click **Enable MFA**.
2. Scan the QR code with an authenticator app (Google Authenticator, Authy, 1Password, Bitwarden, etc.). If your app requires manual entry, use the base32 key displayed below the QR code. The QR code is generated entirely in your browser — the TOTP secret is never sent to any external service.
3. Enter a 6-digit code from your app and click **Confirm**. The server verifies the code before saving the secret — if the code is wrong, the secret is discarded and no change is made.
4. On success, a green **Enabled** badge appears.

> The base32 key is shown only once during enrollment. If you need to recover it later, disable MFA and re-enroll.



### How it works in the client

The web client intercepts any `40 3 MFA_REQUIRED` response and automatically opens a TOTP prompt. Once you enter a valid code:

- The interceptor retries the original request with `X-TOTP-Code` attached.
- The code is **cached in memory** (not `localStorage`) for **15 minutes** so you are not re-prompted on every button click.
- The cache is invalidated if the server returns `MFA_INVALID` (stale or wrong code) or when you navigate away from the page or close the tab.

API clients and MCP clients using admin tokens must supply the header themselves:

```http
POST /api/tokens
Authorization: Bearer ythril_...
X-TOTP-Code: 123456
Content-Type: application/json

{ "name": "new-token" }
```



### TOTP parameters

| Parameter | Value |
|-----------|-------|
| Algorithm | SHA-1 (maximum authenticator compatibility) |
| Step | 30 seconds |
| Digits | 6 |
| Clock tolerance | ±30 s (one step in each direction) |



### Disabling MFA

Click **Disable MFA** in **Settings → MFA** and confirm. Disabling does **not** require an existing TOTP code — this is intentional: it is the recovery path if you lose your authenticator.

Security model: a valid admin PAT is required. Physical possession of `secrets.json` alone is insufficient — you still need an admin token.

After disabling, admin mutations immediately stop requiring `X-TOTP-Code`.



### Rotating the TOTP secret

To move to a new authenticator app or replace a potentially-compromised secret:

1. Disable MFA (no TOTP code needed).
2. Re-enroll from scratch — a fresh secret is generated.



### Recovery if you lose your authenticator

If you have lost access to your authenticator app and cannot produce a valid code, disable MFA directly via the API with an admin PAT:

```bash
curl -X DELETE http://localhost:3200/api/mfa \
  -H "Authorization: Bearer ythril_..."
```

This succeeds with `204 No Content` and immediately removes the TOTP requirement. Re-enroll with a new authenticator when ready.

If you have also lost all admin tokens, there is no API-level recovery path. Restore a backup of `config/secrets.json` or re-run first-run setup with `docker compose down -v && docker compose up`.



---



## Space management



A space is a fully isolated container for memories, entities, edges, and files. Every piece of data lives inside exactly one space.



- The `general` space is created automatically on first run.

- Additional spaces are created from **Settings → Spaces** or via `POST /api/spaces`.

- Each space gets its own MongoDB collections (`{spaceId}_memories`, `{spaceId}_entities`, `{spaceId}_edges`, `{spaceId}_tombstones`), its own file directory (`/data/{spaceId}/`), and its own MCP endpoint (`/mcp/{spaceId}`).

- Spaces are **private by default**. A space only leaves the brain when it is explicitly included in a network.

- **Deleting a space** on a standalone brain is immediate (requires `{ "confirm": true }` in the request body). On a networked brain it opens a vote round so all peers can react before the data is removed locally.



### Space IDs



Space IDs must be alphanumeric plus hyphens, maximum 40 characters, and unique on the instance. Choose IDs that are stable — they appear in MCP endpoint URLs, MongoDB collection names, and file paths. They cannot be renamed after creation.



---



## Storage quotas



Optional soft and hard limits can be configured per category in `config.json`:



```json

"storage": {

  "total": { "softLimitGiB": 150, "hardLimitGiB": 200 },

  "files": { "softLimitGiB": 100, "hardLimitGiB": 140 },

  "brain": { "softLimitGiB": 50,  "hardLimitGiB": 60  }

}

```



| Threshold | Behaviour |

|-----------|----------|

| Below soft limit | Normal write |

| Above soft limit, below hard | Write succeeds; response includes `"storageWarning": true` |

| Above hard limit | Write rejected with HTTP 507 |



Usage is measured at write time — there is no background cache. Current usage per space is visible in **Settings → Storage** and in the `GET /api/spaces` response.



Quota fields are optional. Omitting a category means no limit is enforced for it.



---



## Running multiple brains



Each brain is an independent Docker Compose stack. To run two brains on one machine, give each a separate Compose project name and a different host port.



**Option A — `-p` flag (recommended, no file duplication):**



```bash

# Brain A — default project name, port 3200

docker compose up -d



# Brain B — separate project name, port 3201

# Edit the host port in a second copy of docker-compose.yml first:

#   ports: ["3201:3200"]

docker compose -p ythril-b -f docker-compose.brain-b.yml up -d

```



The `-p ythril-b` flag namespaces all volumes and container names automatically:



| Resource | Brain A | Brain B |

|----------|---------|--------|

| Containers | `ythril`, `ythril-mongo` | `ythril-b-ythril-1`, `ythril-b-ythril-mongo-1` |

| Volumes | `ythril_ythril-data`, etc. | `ythril-b_ythril-data`, etc. |

| Port | 3200 | 3201 |



Keep the `config/` bind-mount directories separate too — each brain needs its own `config.json` and `secrets.json`. Point each stack's `volumes:` section to a different host path (e.g. `./config-a:/config` and `./config-b:/config`).



Each brain then goes through its own first-run setup independently. They know nothing about each other until you explicitly configure a network between them.



---



## Data persistence and recovery



All persistent data lives in **named Docker volumes**, not inside containers. Removing or recreating containers never loses data.



| Volume | What it stores |

|--------|----------------|

| `ythril_ythril-data` | All file storage (`/data/{spaceId}/`) |

| `ythril_ythril-mongo-data` | All brain data: memories, entities, edges, tombstones |

| `ythril_ythril-mongo-configdb` | MongoDB replica set keyfile |



The `config/` directory is a host **bind mount** — `config.json` and `secrets.json` are plain files in your project folder and survive any container lifecycle event.



### Safe stop/start cycle



```bash

docker compose down        # stops and removes containers — data intact

docker compose up          # reattaches volumes — picks up exactly where it left off

```



### Destroying all data



```bash

docker compose down -v     # ⚠ permanently deletes all named volumes

```



This is the only `docker compose` command that destroys brain data. The `-v` flag must be passed explicitly — it is never triggered by accident.



### Recovery after downtime — networked brains



When two brains that are peers in a network both come back up after downtime, no manual reconnection step is required. Each brain:



1. Reconnects to its own MongoDB volume and restores all local state

2. Loads `config.json`, which contains the network and peer configuration

3. Starts the sync cron scheduler

4. On the first scheduled (or manually triggered) sync cycle, sends each peer a request for everything after the last recorded watermark (`lastSeqReceived`)



Tombstone records (delete events) are included in the incremental sync, so any deletions that happened while one brain was offline propagate correctly on the next cycle. No data is duplicated; no data is silently lost.



---



## Brain networks



Networks are the mechanism by which **specific spaces** on one brain are synced with spaces on a peer brain. It is always a **space** — not a whole brain — that participates in a network. A brain can belong to multiple networks simultaneously, each scoped to different spaces.



```

Brain A                          Brain B

├── space: general ────────────── space: general   (via "Personal" network)

├── space: work    ────────────── space: work       (via "Team" network)

└── space: private               (not in any network — never leaves Brain A)

```



A brain's unshared spaces are invisible to all peers regardless of what networks the brain belongs to.



### What a network is



A network is a named configuration object that exists on **every participating brain**. It records:



- The governance type (`closed`, `democratic`, `club`, or `braintree`)

- The space IDs being synced

- The member list (other brains, their URLs, and their peer tokens)

- Any open vote rounds



Each brain's copy of the network is kept in sync by the gossip layer — member changes, vote events, and sync watermarks all propagate during regular sync cycles.



### Governance types at a glance



| Type | Join approval | Good for |

|------|--------------|----------|

| `closed` | All members unanimous | Personal multi-device (every device is yours) |

| `democratic` | ≥ 50% + no vetoes | Small teams where any one member can't block alone |

| `club` | The inviter alone | Open collaboration where the inviter vouches for candidates |

| `braintree` | All ancestors from inviter to root | Hierarchical org where senior nodes control who joins |



For full governance rules and sequencing see [network-types.md](network-types.md).



---



## Creating a network



Open **Settings → Networks** in the left sidebar.



1. Enter a **Network label** (e.g. "Team Brain").

2. Choose a **Type** — see the table below.

3. Enter the **Space IDs** to sync (comma-separated; e.g. `general`).

4. Set a **Voting deadline** in hours (default 48 h — only relevant for democratic/club/braintree networks).

5. Click **Create network**.



The new network appears in the list below the form.



| Type | Who can join |

|------|-------------|

| **Closed** | Invite-only; the admin adds members directly |

| **Democratic** | Simple majority vote among existing members |

| **Club** | Admin decides unilaterally — no vote needed |

| **Braintree** | Hierarchical tree — parent nodes approve children |



> For a detailed explanation of governance rules see [network-types.md](network-types.md).



---



## Inviting another brain



To let another brain join one of your networks:



1. Expand the network card by clicking its row.

2. In the **Invite** section click **Generate invite**.

3. A JSON invite bundle appears. Click **Copy bundle**.

4. Send that bundle to the other brain's admin — by email, chat, or any out-of-band channel.



**The invite expires after 24 hours.** Generate a new one if it lapses.



> **Security:** The bundle contains an RSA-4096 public key and a one-time handshake ID. No authentication token is included — the cryptographic exchange happens server-side when the other brain joins.



---



## Joining a network



On the brain that was *invited* (Brain B):



1. Open **Settings → Networks**.

2. Find the **Join an existing network** card.

3. Paste the invite bundle JSON you received into the textarea.

4. Enter **this brain's publicly reachable URL** (e.g. `https://brain-b.example.com`).  

   This is the address Brain A will use to reach Brain B for sync — it must be reachable from Brain A.

5. Click **Join network**.



Ythril performs the RSA handshake in the background. Both brains exchange sync tokens securely without any token ever appearing in the UI. On success the network appears in Brain B's network list.



> **First sync** happens on the next scheduled cycle. Click **Sync now** inside the network card to run it immediately.



---



## Managing members



Expand a network card to see its current member list.



### Remove a member



Click the **×** button on the right of any member row and confirm the prompt.



| Network type | Result |

|---|---|

| Closed | Member removed immediately |

| Democratic / Club | Vote round opened; removal takes effect when threshold is met |

| Braintree | Ancestors in the tree must approve — see [Braintree networks](#braintree-networks) |



---



## Sync schedule



Expand a network card and find the **Sync** section.



- Enter a **cron expression** in the schedule field (e.g. `0 * * * *` for every hour on the hour). Leave empty for manual-only sync.

- Click **Save schedule** to persist it.

- Click **Sync now** to run an immediate sync cycle regardless of the schedule.



Standard 5-field cron syntax: `minute hour day month weekday`.  

6-field (seconds-precision): prepend a seconds field, e.g. `0 0 * * * *` (every minute at :00).



---



## Governance and voting



For democratic, club, and braintree networks, some operations (join, remove member) open a **vote round** instead of taking effect immediately.



When a pending vote exists on a network, expand that network's card and scroll to the **Open votes** section. Each entry shows:



- The operation type (`join` or `remove`) and the subject name

- **✓ Yes** and **✗ No** buttons



Cast your vote once on your own brain. Votes are propagated to all peers during the next sync cycle — you do not need to reach every brain directly.



### How rounds conclude



| Network type | Passes when |

|---|---|

| Democratic | More than half of current members vote yes (no vetoes) |

| Club | N/A — admin adds and removes members directly without voting |

| Closed | All current members vote yes |

| Braintree | All ancestors of the proposer vote yes (see below) |



A single **veto** (`no` vote) from any required voter immediately closes the round as failed, regardless of remaining yes votes.



---



## Braintree networks



Braintree is a hierarchical governance model. Each brain has a fixed position in a parent–child tree. Governance decisions flow up the tree: the proposer and all ancestors up to the root must approve.



### Setting up a braintree in the UI



**Step 1 — Create the network on the root brain**



On Brain A (Root): open **Settings → Networks**, create a network with type **Braintree**.



**Step 2 — Invite Brain B as a direct child of Root**



Still on Brain A:



1. Expand the network card → **Generate invite** → copy bundle.

2. Send bundle to Brain B's admin.



On Brain B:



1. **Settings → Networks → Join an existing network**.

2. Paste the bundle, enter Brain B's URL, click **Join network**.

3. Brain B is now a leaf node directly under Root.



Because Root is a single-ancestor chain for this join, Brain A auto-approves and the join completes immediately.



**Step 3 — Add a grandchild (requires Root approval)**



On Brain B, invite Brain C the same way. When Brain C joins, the round needs approval from both Brain B and Brain A (Root). Brain B auto-casts yes. Root sees the vote round on the next sync cycle (or use **Sync now**). Open the network card on Root, find the vote under **Open votes**, and click **✓ Yes**.



### How the ancestor-path rule works



Every join or removal triggers a vote round on the **proposing brain**. Required voters are the proposing brain plus every ancestor up to the root:



```

Root  ← must vote yes

  └── Node A  ← opened the round, auto-votes yes

        └── Leaf B (candidate)

```



Root-level additions have a single required voter (Root itself), so Root auto-approves them → `201` response, no round opened.



### Registering an existing network on a new brain (API)



If you need to set up a brain as an intermediate node without using the join-via-invite flow, you can register the network via the API specifying `myParentInstanceId`:



```json

POST /api/networks

{

  "id": "<existing network id>",

  "label": "Engineering team",

  "type": "braintree",

  "spaces": ["eng-kb"],

  "myParentInstanceId": "<instanceId of parent brain>"

}

```



---



## Leaving a network



Expand the network card and click **Leave network** at the bottom.



This broadcasts a departure notification to all peers before removing the network locally. Your data in the network's spaces is kept — only the network config is removed.



For braintree networks, a departing intermediate node partitions its subtree. Leaves beneath it must wait for the parent to return or be re-admitted under a different parent.



> **API reference:**

> ```

> DELETE /api/networks/:id

> Authorization: Bearer <PAT>

> ```



---



## Forking a network



Forking creates a new independent network seeded from your local copy of the data. This is useful when you have been ejected or want to start a parallel network from a snapshot.



Forking is available via the API only:



```

POST /api/networks/:id/fork

Authorization: Bearer <PAT>

Content-Type: application/json



{

  "label": "My fork",

  "type": "closed",

  "votingDeadlineHours": 24,

  "spaces": ["space-id-1"]

}

```



| Field | Required | Description |

|---|---|---|

| `label` | Yes | Human-readable name for the new network |

| `type` | No | `closed` (default) or `club` |

| `votingDeadlineHours` | No | Defaults to the source value, or 24 |

| `spaces` | Conditional | Required if ejected (source network already removed); optional otherwise |



**Scenarios:**



- **Still a member** — `:id` matches a live network. Spaces and deadline are inherited; you can override both.

- **Ejected** — when a `member_removed` event is received the source `NetworkConfig` is deleted and its id is recorded in `ejectedFromNetworks`. You **must** supply `spaces` explicitly because the source config is gone.

- **Unknown id** — not in networks or `ejectedFromNetworks` → `404`.



The fork gets a fresh UUID, no members, and no pending rounds. You become the implicit root and can invite peers via the normal generate-invite → join flow.



---



## Triggering sync manually



Use the **Sync now** button inside any network card, or call the API directly:



```

POST /api/notify/trigger

Authorization: Bearer <PAT>

Content-Type: application/json



{ "networkId": "<network id>" }

```



Returns `200 { "status": "triggered" }` immediately; the cycle runs asynchronously. Useful during governance flows when you want to push a just-cast vote or pull a peer's open rounds without waiting for the scheduled interval.

---

## Conflict resolution

When two instances modify the same file before syncing, the sync engine detects the hash mismatch and creates a **conflict record**. The incoming version is saved as a conflict copy alongside the original.

### Viewing conflicts

Open **Files → Conflicts** in the web UI, or call `GET /api/conflicts`.

### Resolution actions

Each conflict can be resolved with one of four actions:

| Action | What happens |
|--------|-------------|
| **Keep local** | Deletes the conflict copy (incoming file). Your local file is unchanged. |
| **Keep incoming** | Replaces your local file with the incoming copy. The conflict copy is removed. |
| **Keep both** | Keeps both files as-is. Optionally rename the conflict copy via the `rename` parameter. |
| **Save to space** | Copies the conflict copy to a different space, then removes it from the source. Requires `targetSpaceId`. |

### API: resolve a single conflict

```
POST /api/conflicts/:id/resolve
Authorization: Bearer <PAT>
Content-Type: application/json

{ "action": "keep-local" }
```

For `keep-both` with rename:
```json
{ "action": "keep-both", "rename": "notes-incoming.md" }
```

For `save-to-space`:
```json
{ "action": "save-to-space", "targetSpaceId": "archive" }
```

### API: bulk resolve

```
POST /api/conflicts/bulk-resolve
Authorization: Bearer <PAT>
Content-Type: application/json

{
  "ids": ["conflict-id-1", "conflict-id-2"],
  "action": "keep-local"
}
```

Returns `{ "resolved": 2, "failed": [] }`. Failed items include `{ "id": "...", "error": "..." }`.

### UI workflow

1. Navigate to **Files → Conflicts**.
2. Select an action per conflict from the dropdown (Keep local · Keep incoming · Keep both · Save to space).
3. Click **Resolve** per row, or select multiple and use the bulk action bar.
4. The **Dismiss** button (✕) removes only the conflict record without touching files.



---



## Merkle integrity



Each network can opt in to Merkle-based divergence detection. When enabled, the sync engine computes a SHA-256 binary Merkle tree over the contents of each shared space after every sync cycle and compares roots with the remote peer. A mismatch is logged as a `MERKLE_DIVERGENCE` warning — no automatic corrective action is taken.



### Enabling Merkle for a network



Add `"merkle": true` when creating or registering a network via the API:



```json

POST /api/networks

{

  "label": "My secure net",

  "spaces": ["shared"],

  "merkle": true

}

```



### Querying the Merkle root



```

GET /api/sync/merkle?spaceId=<space id>&networkId=<network id>

Authorization: Bearer <PAT>

```



Response:



```json

{

  "spaceId": "shared",

  "networkId": "<network id>",

  "root": "<64-char hex SHA-256>",

  "leafCount": 42,

  "computedAt": "2025-01-01T00:00:00.000Z"

}

```



| Field | Description |

|-------|-------------|

| `root` | SHA-256 Merkle root of all documents and files in the space. An empty space returns `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. |

| `leafCount` | Number of leaf nodes (documents + files) that were hashed. |

| `computedAt` | ISO timestamp when the root was last computed. |

