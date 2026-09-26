# Networks & Invite APIs

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Who may call what

Since F-34 a token below instance admin acts on a network through the **`networks`** rung it holds on the spaces the network carries — on **every** one of them ([Tokens API → the `networks` area](07-tokens-api.md#what-a-right-grants)).

| route | needs, on every space the network carries |
|---|---|
| `GET /api/networks` | `read` — the list holds only the networks you may see |
| `GET /api/networks/:id` | `read` — otherwise `404`, never `403` |
| `POST /api/networks` | `write` — the membership is recorded as yours |
| `PATCH /api/networks/:id` | `admin` — the settings are shared by every space |
| `DELETE /api/networks/:id` | `write` for a membership you established, `admin` for anyone's (or one with no recorded establisher) |
| `POST /api/networks/:id/spaces` | `admin` on every space it already carries, and `write` on the space being added — or administering each of them. On club, closed and democratic networks it opens a vote |
| `POST /api/networks/join-remote` | `write` on every existing local space the join maps to; a space it would create needs `createSpaces` and a floor of `write` too. Checked after the handshake's apply and before finalize — refused, nothing is written and the handshake expires |

**A space admin needs no Networks column for its own spaces** (F-37). A token that administers every space an act touches may create a network carrying them, join one mapped onto them (onto a NEW space too, when it also holds `createSpaces`), see the network, and generate its invite (`POST /api/invite/generate`, `POST /api/networks/:id/invite`) — which is what makes a network it created joinable. A space it does not administer still needs the column, and the refusal names it.

Everything else on this router — members, signing keys, topology (including a reparent invite), votes, sync and sync history — acts on the network as a whole and stays **instance-admin**. Invites do too, except for the space admin above. MCP `network_peers` lists the peers of the networks you may see, through the same filter as `GET /api/networks`.

**On MCP** (F-36): `network_get`, `network_create`, `network_update`, `network_leave` and `network_add_space` are the same acts as `GET /api/networks/:id`, `POST /api/networks`, `PATCH /api/networks/:id`, `DELETE /api/networks/:id` and `POST /api/networks/:id/spaces` — same parameters (the network is `id`), the same rights, the same refusal sentences and the same body. `network_votes`, `network_vote` and `network_sync_history` are `GET /api/networks/:id/votes`, `POST /api/networks/:id/votes/:roundId` and `GET /api/networks/:id/sync-history`, instance-admin on both doors. `network_invite` and `network_fork` are `POST /api/networks/:id/invite` (instance admin, or administering every space) and `POST /api/networks/:id/fork` (instance admin). `network_join_remote` is `POST /api/networks/join-remote` — the same handshake, the same Networks rung checked between apply and finalize, and an inviter's refusal relayed with its own sentence. `network_member_add` and `network_member_remove` are `POST /api/networks/:id/members` and `DELETE /api/networks/:id/members/:instanceId`, instance-admin on both doors, with the same vote-or-direct answer per network type. `network_member_admit` is `POST /api/networks/:id/join` (the inviter's half of a join by invite key), `network_member_signing_key` is `PUT /api/networks/:id/members/:instanceId/signing-key`, and `network_reparent_self`, `network_member_adopt` and `network_member_revert_parent` are the three braintree topology routes — all instance-admin on both doors. Every network route now has its tool.

## Networks API

Base path: `/api/networks` — requires `admin` token.

### List Networks

```http
GET /api/networks
```

**Response** `200`:

```json
{
  "networks": [
    {
      "id": "net-uuid",
      "label": "Team Sync",
      "type": "closed",
      "spaces": ["general"],
      "members": [
        {
          "instanceId": "peer-uuid",
          "label": "Peer Brain",
          "url": "https://peer.example.com",
          "direction": "both"
        }
      ]
    }
  ]
}
```

---

### Get Network

```http
GET /api/networks/:id
```

Returns one network object (same shape as entries in `GET /api/networks`).

**Response** `200` on success, `404` when the network does not exist or you may not see it.

**`myRole` says what THIS instance is in the network** (F-38.1), and which members that role acts on — each list
holds instance ids into `members`:

| type | `role` | `members` | also |
|---|---|---|---|
| `pubsub` | `publisher` | its subscribers | |
| `pubsub` | `subscriber` | empty | `publisher` |
| `club` | `organiser` (it created the network) or `member` | its peers | |
| `closed`, `democratic` | `member` | its peers | |
| `braintree` | `root`, `node` or `leaf` | everything below it | `pathToRoot` (parent first), `subtree` |

A club network stored before 5.2 has no record of which instance created it and reads as `member`. MCP
`network_get` returns the same field.

---

### Create a Network

```http
POST /api/networks
```

```json
{
  "label": "Team Sync",
  "type": "closed",
  "spaces": ["general"],
  "votingDeadlineHours": 24,
  "syncSchedule": "*/5 * * * *",
  "requireSignedVotes": false
}
```

**Network types**: `closed` (unanimous vote), `democratic` (majority), `club` (proposer only), `braintree` (tree hierarchy), `pubsub` (auto-join publisher/subscriber, push-only).

**`requireSignedVotes`** (optional, default `false`): when `true`, governance vote casts must carry a valid Ed25519 signature from the voting member (strict mode). Leave it off until every member has synced at least once so their signing keys are published; then enable it (also settable via `PATCH`) to reject any unsigned or forged vote. See [Sync Protocol → Signed vote casts](../sync-protocol.md).

**`syncSchedule`** (optional): how often this network syncs automatically. Give a standard **cron expression** (e.g. `"*/5 * * * *"` = every 5 minutes, `"0 * * * *"` = hourly) — the same node-cron engine the backup scheduler uses. Omit it (or set it empty) for manual-sync only.

**A value the scheduler cannot run is now REFUSED with a `400`** on both the create and the update, and the message names the format. It used to be accepted and then ignored with a startup warning, which meant a caller got a `2xx` for a network that would never sync again — and the only evidence was in a server log.

> **The two legacy shorthands were REMOVED in 4.0.** `"*/N minutes"` / `"every Nm"` (1–59) and `"*/N hours"` / `"every Nh"` (1–23) were translated to cron for the whole of 2.x and 3.x. Sending one now returns a `400` **naming the cron expression it used to mean**, so the fix is a copy and paste: `"every 5m"` → `"*/5 * * * *"`, `"every 2h"` → `"0 */2 * * *"`.
>
> A shorthand already stored in `config.json` is rewritten to that same expression at boot, so an existing network keeps syncing at the rate it was given — nothing to do on upgrade.
>
> **One case has no translation and is worth checking for.** A shorthand outside cron's range — `"every 90m"`, `"every 40h"` — never resolved to anything, so any network holding one has been on manual sync since the day it was set. Those are left exactly as stored and named individually in the startup log, because rounding one to the nearest cron expression would be the server deciding when to sync.

**Response** `201`: the created network object.

---

### Delete a Network

```http
DELETE /api/networks/:id
```

Broadcasts `member_departed` to all peers. **Response** `204` on success, or `200` with `{ ok: true, warnings: [...] }` if some peer notifications failed.

---

### Update a Network

```http
PATCH /api/networks/:id
```

```json
{ "syncSchedule": "*/10 * * * *", "label": "Renamed", "requireSignedVotes": true }
```

---

### Pending Spaces

A space the network proposed and this instance did not add on its own: announced by an upstream, or carried by a
passed `space_addition` round this instance did not propose. **A space whose id already exists here always waits**,
whoever joined. `GET /api/networks/:id` lists them as `pendingSpaces`, each `{ networkId, localId, why, from, at }`,
and the ones the operator dismissed as `dismissedSpaces`.

**Why a space waits.** The token that joined or created the network here decides what the network may add later, by the rule
the join itself ran: an existing local space needs `networks: write` on it or administering it, a new one needs
`createSpaces` (and a `write` floor on `networks`, unless the token is a space administrator). A space waits when:

- the joining token could not have joined it;
- a local space already has its id: joining it would start syncing a space that only shares a name;
- the network has no recorded joining token (it was joined or created before 5.4), or that token no longer exists
  or has expired.

```http
POST /api/networks/:id/pending-spaces
```

```json
{ "spaceId": "research", "action": "accept", "mapTo": "team-research" }
```

`action` is `accept` or `dismiss`. `mapTo`, accept only, carries the network's space under a different local id; an
existing local space named there is joined to the network. Accepting is priced like a join, over YOUR token:
`networks: write` on an existing space (or administering it), `createSpaces` for a new one. Dismissing records the
answer in `dismissedSpaces`, so neither an announcement nor a passed round proposes that space again, and needs
`networks: admin` on every space the network carries. A dismissed space can still be accepted by its id. Answers `200` with the network. MCP:
`network_pending_space` with `{ "id", "spaceId", "action", "mapTo"? }`.

| status | when |
|---|---|
| `400` | a malformed body, or a `mapTo` that is not a space id |
| `403` | the token is short on the right the action needs; the refusal names what |
| `404` | no such network, or nothing pending under `spaceId` |
| `409` | the network already carries the local id |
| `500` | the space could not be added; the pending entry is kept, so the accept can be retried |

### Add a Space to a Network

```http
POST /api/networks/:id/spaces
```

```json
{ "spaceId": "research" }
```

Adds one of this instance's spaces to a network. Answers `200` with the network as `GET /api/networks/:id` shows it when the space is carried at once, or `202` with `{ "status": "vote_pending", "round" }` when the network has to agree first. MCP: `network_add_space` with `{ "id", "spaceId" }`.

**Who decides, per type:**

| type | who may add | what happens |
|---|---|---|
| `pubsub` | the publisher | added at once |
| `braintree` | the root | added at once |
| `club` | the organiser (the instance that created it) | a `space_addition` round its own yes carries, so added at once |
| `closed` | any member | a `space_addition` round; added when every member votes yes |
| `democratic` | any member | a `space_addition` round; added on a majority with no veto |

**What follows, without another call:**

- The tokens this instance issued to the network's members reach the new space as soon as it is carried, so their sync of it is not refused.
- On `pubsub` and `braintree` the member exchange names the space, and an instance considers it only from its **upstream** (a subscriber from its publisher, a tree node from its parent), never from anyone else. **The announcement is a proposal, not a grant**: the space is added only if the token that joined the network here could have joined it (see [Pending Spaces](#pending-spaces)); otherwise it waits for the operator.
- On `club`, `closed` and `democratic` every member applies the passed round itself, re-deciding it from the casts under its own rule. The proposer keeps serving the passed round on `GET /api/sync/networks/:id/votes`, so a member that never saw it open still learns it.
- The receiving side only adds. A space it lacks is created with the network's id. **On the three voted types, a member that already has a local space of that name keeps it out of the network unless it voted yes**: those networks sync both ways, so joining it would send its records to every member. The skip is logged. On `pubsub` and `braintree` a same-named local space is never joined by an announcement: it waits as pending until the operator maps it or accepts it under another id.

| status | when |
|---|---|
| `400` | `spaceId` missing, or no such space on this instance |
| `403` | the token is short on a right above; the refusal names what |
| `404` | no network with this id that the token may see |
| `409` | the network already carries the space, a vote to add it is already open, or this instance is not the publisher, root or organiser the type requires |

---

### Add a Member (Manual)

```http
POST /api/networks/:id/members
```

```json
{
  "instanceId": "peer-instance-uuid",
  "label": "Remote Brain",
  "url": "https://remote.example.com",
  "token": "ythril_peerToken...",
  "direction": "both"
}
```

In `closed`/`democratic` networks this opens a voting round.
In `club` networks the member is added immediately.
In `braintree` networks all ancestors up to the root must approve.
In `pubsub` networks the subscriber is added immediately with `direction` forced to `push` (publisher pushes to subscriber) regardless of the request body value.

---

### Join via Invite Key

```http
POST /api/networks/:id/join
```

**The inviter's half, called on the inviting instance by the joining peer** (MCP `network_member_admit`): an
instance-admin route of the peer protocol, not a way for a stranger to join. To join a pub/sub from its published key
with nothing but that key, use [Join a Pub/Sub by Its Published Key](#join-a-pubsub-by-its-published-key) on your own instance.

```json
{
  "inviteKey": "the-shared-key",
  "instanceId": "my-uuid",
  "label": "My Brain",
  "url": "https://me.example.com",
  "token": "ythril_myToken..."
}
```

**Response** — depends on the network's governance:

- `club` / `pubsub`: `200` `{ "status": "joined", "members": [...], "networkId": "..." }` — direct join, no vote.
- `closed` / `democratic` / `braintree`: `202` `{ "status": "vote_pending", "roundId": "..." }` — the member
  is **held in the vote round** (no sync possible) until the required voters approve (closed: all members;
  democratic: majority; braintree: every ancestor from the inviting node to the root). Exception: a join on a
  braintree **root** concludes immediately (the root is the only required voter) and returns `200 joined`.
- In a braintree the joiner always becomes a **child of the instance it joins through**; `parentInstanceId`
  and `direction` from the request body are ignored for braintree joins.

The invite key is consumed when the round opens (pubsub keys stay reusable). **Re-presenting the same key
with the same `instanceId` polls the outcome**: `202` while the vote is open, `200 joined` with the member
list once admitted, `403` if the round was vetoed or expired.

---

### Cast a Vote

```http
POST /api/networks/:id/votes/:roundId
```

```json
{ "vote": "yes" }
```

Accepted values: `yes`, `veto`.

A concluded `space_deletion` or `space_wipe` round acts on a member only when it **passed** with no veto — a round
that expired is concluded but not passed, and deletes nothing — and only on the space it names as mapped to that
member and carried by the round's own network. Each member applies it once; gossip re-delivering the round does not
re-apply it.

The instance that opens a round other than a join or a removal is one of its voters: its signed `yes` is in `votes`
from the moment the round opens, and the round's `subjectInstanceId` is informational on those types. A peer cannot
make another member the proposer by naming it there.

---

### List Open Vote Rounds

```http
GET /api/networks/:id/votes
```

**Response** `200`:

```json
{
  "rounds": [
    {
      "roundId": "round-uuid",
      "type": "join",
      "subjectInstanceId": "peer-uuid",
      "deadline": "2026-04-12T12:00:00.000Z",
      "votes": []
    }
  ]
}
```

Only non-concluded rounds are returned.

---

### Join a Pub/Sub by Its Published Key

```http
POST /api/networks/join-by-key
```

```json
{ "publisherUrl": "https://publisher.example.com", "inviteKey": "ythril_invite_...", "myUrl": "https://me.example.com" }
```

Called on the JOINING instance. Joins a pub/sub network with nothing but its publisher's URL and its published invite
key: this instance redeems the key at the publisher (below), then runs the same handshake as
[Join Remote](#join-remote-rsa-handshake), so the answer, the optional `spaceMap` and the rights are the same. `networks: write` (or
administering the space) on every existing local space the join maps to, and `createSpaces` for any it creates; the
joining token is also what later decides which announced spaces the network may add ([Pending Spaces](#pending-spaces)).
MCP: `network_join_by_key` with the same fields.

| status | when |
|---|---|
| `400` | a malformed body, or a URL that is not a safe peer URL |
| `403` | the publisher does not recognise the key, or the token is short on a right the join needs |
| `429` | too many joins by key are open for that network on the publisher |
| `502` | the publisher could not be reached, or answered without a usable handshake |

### Redeem an Invite Key (publisher side)

```http
POST /api/invite/redeem
```

```json
{ "inviteKey": "ythril_invite_..." }
```

**Not authenticated: the key is the credential.** Answers `201` with a handshake bundle, the same shape
`POST /api/invite/generate` returns, for a pub/sub network this instance PUBLISHES whose current key it is. Any other
key, including a club, closed or braintree network's, answers `403` with one message whatever the reason, so a caller
cannot learn which networks exist. Bounded because it is anonymous and each call generates a key pair: the
authentication rate limit per caller, at most 25 redeemed handshakes open per network and 3 per caller address
(`429`), and a redeemed handshake expires after 10 minutes rather than the hour an admin's invite lives.
**Regenerating the key revokes it for new joins and closes every handshake it already opened**; members who already
joined stay until removed.

### Generate an Invite Key

```http
POST /api/networks/:id/invite
```

**Response** `200`:

```json
{
  "inviteKey": "ythril_invite_...",
  "networkId": "net-uuid",
  "reusable": false,
  "note": "Store this key securely — it is single-use and will not be shown again"
}
```

For `pubsub` networks, `reusable` is `true` and the note explains the key can be shared publicly.

To rotate/revoke the current key, call this endpoint again — the newly generated key replaces the previous hash.

---

### Join Remote (RSA Handshake)

```http
POST /api/networks/join-remote
```

```json
{
  "handshakeId": "uuid",
  "inviteUrl": "https://remote.example.com/api/invite/apply",
  "rsaPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n...",
  "networkId": "net-uuid",
  "myUrl": "https://me.example.com",
  "spaceMap": {
    "remote-space-id": "local-space-id"
  }
}
```

Executes the full 3-step RSA handshake server-side. No plaintext tokens cross the wire.

**`spaceMap`** (optional) — a `Record<string, string>` that maps remote space IDs to local space IDs. Use this when a remote space name collides with an existing local space and you want to alias it to a different local name instead of merging. If omitted, remote space IDs are used as-is (identity mapping). The map is persisted on the `NetworkConfig` and used by the sync engine to translate space IDs during pull and push.

### Join Troubleshooting: private or local URLs rejected

If join fails with a validation error like:

```json
[
  {
    "code": "custom",
    "path": ["instanceUrl"],
    "message": "Peer URL must use http(s) and must not target private IPs, loopback, ULA/link-local IPv6, cloud metadata endpoints, or include embedded credentials"
  }
]
```

the peer URL failed SSRF-safe validation.

Blocked examples:

- `http://localhost:3200`
- `http://127.0.0.1:3200`
- `http://192.168.1.50:3200`
- `http://10.0.0.20:3200`
- `http://[fd00::1]:3200`
- URLs with embedded credentials like `https://user:pass@host.example.com`

Allowed examples:

- `https://brain-a.example.com`
- `https://sync.mycompany.tld`

What to do:

1. Use a publicly reachable URL for the joining brain (`myUrl` / `instanceUrl`) and inviter `inviteUrl`.
2. Ensure both brains can reach each other over that URL.
3. Retry the join flow with updated URLs.

Notes:

- This validation is enforced for `Join via Invite Key`, `Join Remote`, and invite `apply` payloads.
- There is no runtime toggle to allow private or loopback peer URLs in these endpoints. `SYNC_ALLOW_PRIVATE_PEERS` (and the `allowPrivatePeers` config key) relaxes only the sync-time/gossip URL check used when connecting to and storing already-known peers; the join / member-add URL validation shown here always uses the strict SSRF check regardless of that setting.

---

### Change Notes

A change note travels with a downward sync — a publisher to its subscribers, a tree node to its children —
attached with the `{ note, spaces }` body of `POST /api/networks/:id/sync` (see
[Sync API → A sync can carry a change note](09-sync-api.md#a-sync-can-carry-a-change-note)).

```http
GET /api/networks/:id/change-notes?direction=in&limit=50
```

Instance-admin, like the sync door. Answers `{ networkId, direction, notes }`, newest first: `in` (default) what
arrived here from the instance above, `out` what was written here with `pendingFor`, the members it has not
reached. A note the network drafted itself (a schema update it carried, a space added) has `generated: true`.
`400` for a `direction` other than `in`/`out` or a `limit` outside 1–200; `404` for an unknown network. MCP:
`network_change_notes`.

---

### Sync History

```http
GET /api/networks/:id/sync-history?limit=20
```

**Response** `200`:

```json
{
  "history": [
    {
      "_id": "...",
      "networkId": "...",
      "triggeredAt": "2026-03-26T12:00:00.000Z",
      "completedAt": "2026-03-26T12:00:02.500Z",
      "status": "success",
      "pulled": { "facts": 5, "entities": 2, "edges": 1, "files": 0 },
      "pushed": { "facts": 3, "entities": 0, "edges": 0, "files": 1 }
    }
  ]
}
```

**`status` says whether every member's transfers completed.** `success` means each member was reached and every
transfer finished; `partial` means some members did not; `failed` means none did. A member counts as not
completed when any of its transfers was refused or cut short (a `403`, a failed batch, no peer token), and
`errors` then names the member, the space, the direction and the transfers that stopped. `errors` is present
only when something failed.

`limit` defaults to 20, max 100. Ordered most-recent-first. The last 100 records per network are retained; older entries are pruned automatically.

---

### Fork a Network

```http
POST /api/networks/:id/fork
```

```json
{
  "label": "My fork",
  "type": "closed",
  "votingDeadlineHours": 24,
  "spaces": ["space-id-1"]
}
```

Creates a new independent network from your local copy of the data.

| Field | Required | Description |
|---|---|---|
| `label` | Yes | Name for the new network |
| `type` | No | `closed` (default) or `club` |
| `votingDeadlineHours` | No | Defaults to source value, or 24 |
| `spaces` | Conditional | Required if ejected; optional if still a member |

**Scenarios:**

- **Still a member** — spaces and deadline inherited from source; can be overridden.
- **Ejected** — source config is deleted on `member_removed`; `spaces` must be supplied explicitly.
- **Unknown ID** — `404`.

The fork gets a fresh UUID, no members, no pending rounds. You become the root.

---

### Remove a Member

```http
DELETE /api/networks/:id/members/:instanceId
```

In `closed`/`democratic` networks this opens a removal voting round (**202**). In `club` networks the member is removed immediately (**204**). In `braintree` networks the ancestor path must vote; if the subject is a direct child, the round auto-concludes.

**Response** `204` (immediate removal) or `202`:

```json
{ "status": "vote_pending", "roundId": "round-uuid" }
```

---

### Rotate the Instance Signing Key

```http
POST /api/admin/rotate-signing-key
```

Generates a new Ed25519 governance vote-signing keypair and a continuity proof signed by the old key. Peers that pinned the old key adopt the new one automatically on the next sync; the new public key is returned. Requires an **unrestricted** admin token (a space-restricted admin gets `403`), plus a TOTP code when MFA is enabled.

**Response** `200`: `{ "ok": true, "signingPublicKey": "-----BEGIN PUBLIC KEY-----…" }`

### Force-Pin a Member's Signing Key (break-glass)

```http
PUT /api/networks/:id/members/:instanceId/signing-key
```

```json
{ "signingPublicKey": "-----BEGIN PUBLIC KEY-----…" }
```

Force-sets a member's pinned signing key **without** a rotation proof — recovery for when a peer lost its old private key and cannot produce one. Admin only. **Response** `200`: `{ "ok": true, "instanceId": "…" }`.

---

### Reparent Self (Braintree)

Called by a braintree child node on itself after completing an RSA handshake with a grandparent. Records a temporary reparent so the node syncs through the grandparent while its original parent is offline.

```http
POST /api/networks/:id/reparent-self
```

```json
{
  "newParentInstanceId": "grandparent-uuid",
  "newParentLabel": "Grandparent Brain",
  "newParentUrl": "https://grandparent.example.com",
  "tokenForNewParent": "ythril_peerToken...",
  "originalParentInstanceId": "original-parent-uuid"
}
```

**Response** `200`:

```json
{
  "status": "reparented",
  "newParentInstanceId": "grandparent-uuid",
  "originalParentInstanceId": "original-parent-uuid"
}
```

Only valid for `braintree` networks. Returns `400` for other types.

---

### Adopt Member (Braintree)

Called on the grandparent to make a temporary reparent permanent. The member's parent is officially changed.

```http
POST /api/networks/:id/members/:instanceId/adopt
```

No request body.

**Response** `200`:

```json
{
  "status": "adopted",
  "instanceId": "child-uuid",
  "parentInstanceId": "grandparent-uuid"
}
```

Returns `409` if the member is not in a temporary reparent state.

---

### Revert Parent (Braintree)

Called on the grandparent when the original parent comes back online. Restores the member to its original parent and removes the direct grandparent link.

```http
POST /api/networks/:id/members/:instanceId/revert-parent
```

No request body.

**Response** `200`:

```json
{
  "status": "reverted",
  "instanceId": "child-uuid",
  "parentInstanceId": "original-parent-uuid"
}
```

Returns `409` if the member is not in a temporary reparent state.

---

## Invite API

Base path: `/api/invite` — unauthenticated endpoints (rate-limited).

### Generate Invite

```http
POST /api/invite/generate
Authorization: Bearer <admin-token>
```

```json
{ "networkId": "net-uuid" }
```

Optional fields:

| Field | Purpose |
|---|---|
| `expectedInstanceId` | Pin the invite to one `instanceId`. Only that instance may `apply` the bundle — a leaked or forwarded invite link cannot be redeemed by anyone else. |
| `reparentInstanceId` | Braintree reparent (not a new join): move this already-existing member under this instance. The invite is bound to that `instanceId` — applying it as any other instance is refused, so a reparent bundle cannot seize a different member's record. |

**Response** `201`:

```json
{
  "handshakeId": "uuid",
  "networkId": "net-uuid",
  "inviteUrl": "https://me.example.com/api/invite/apply",
  "rsaPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n...",
  "expiresAt": "2026-03-25T15:00:00.000Z",
  "inviteCode": "ythril1_eyJoYW5kc2hha2VJZCI6..."
}
```

#### `inviteCode` — the same bundle as one line, and the thing to give a person

`inviteCode` carries every field above, base64url-encoded behind a readable prefix. It exists because the
object does not survive being sent to somebody: a PEM key contains line breaks, so the bundle wraps in email
and breaks in chat clients, and a recipient looking at braces and quotes has no idea what they may safely
touch. The code is one unbroken line with none of that in it.

**Prefer it when a HUMAN is in the path.** An integrator wiring two instances together can keep reading the
fields; an operator sending an invite to a colleague should send the code.

**It is an ENCODING, not encryption.** Anyone can decode it in one command, and it contains the
`handshakeId` — which `apply` and `finalize` below accept as their only credential. Send it the way you
would send a password. What limits the exposure is the same thing that limits any short-lived ticket: the
handshake expires (see `expiresAt`) and is consumed when it is applied.

**The token `apply` hands the joiner expires with the handshake, until `finalize` makes the membership real.**
Finalize within the window, or that token stops authenticating and the join has to start again with a new
invite. A token for a membership that never completed used to live for ever, belonging to no member — so an
instance also revokes, at start, any peer token whose instance shares no network with it.

**One token per peer, reaching every network the two share.** An instance stores one token per peer, so the token a
handshake hands over replaces the previous one for every network the pair shares. It is therefore scoped to the
spaces of all of those networks, not only the one being joined. That is not wider access: each sync request is
admitted only to the spaces of networks the peer is currently a member of.

**Why the whole bundle travels rather than a short URL to fetch it from.** `rsaPublicKeyPem` is what pins
the handshake to the intended instance. If the joiner fetched it instead, whoever controls that fetch could
substitute their own key, and the joiner would encrypt to them. Carrying it keeps the key out of band and
adds no unauthenticated endpoint.

A joiner that receives a code decodes it and posts the fields to `apply` exactly as before — there is no
second endpoint and no different flow.

---

### Apply (Unauthenticated — called by joining brain)

```http
POST /api/invite/apply
```

```json
{
  "handshakeId": "uuid",
  "networkId": "net-uuid",
  "instanceId": "joiner-uuid",
  "instanceLabel": "Joiner Brain",
  "instanceUrl": "https://joiner.example.com",
  "rsaPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n..."
}
```

**Response** `200`:

```json
{
  "encryptedTokenForB": "base64...",
  "rsaPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n...",
  "instanceId": "inviter-uuid",
  "instanceLabel": "Inviter Brain",
  "networkId": "net-uuid",
  "networkLabel": "Team Sync",
  "networkType": "closed",
  "spaces": ["general"]
}
```

All tokens are RSA-OAEP-SHA256 encrypted — never plaintext over the wire.

**An `instanceId` that is already a peer here must prove it.** The token this step mints reaches every network the
inviter already shares with that instance id, so when the id is a member of any network on the inviter, the request
must carry `Authorization: Bearer <a token the inviter issued to that peer>` — the one the joiner syncs with. Without
it the apply is refused with `403` and nothing is minted. An id the inviter does not know needs no header.
`POST /api/networks/join-remote` sends the header itself, and on the joiner's side it refuses an inviter that claims
the id of a peer it already knows unless the invite URL has that peer's recorded origin.

---

### Finalize

```http
POST /api/invite/finalize
```

```json
{
  "handshakeId": "uuid",
  "encryptedTokenForA": "base64..."
}
```

**Response** `200`:

```json
{ "status": "joined", "instanceId": "joiner-uuid", "networkId": "net-uuid" }
```

On vote-governed networks (`closed`, `democratic`, `braintree`) the join is **held in a vote round**
instead of taking effect immediately — the response is then
`{ "status": "vote_pending", "roundId": "...", ... }`. The inviting instance's own yes vote is cast
implicitly (its admin generated the invite), so the common cases — first member of a closed network,
leaf under a braintree **root** — still conclude immediately and return `"joined"`. While the round is
open the joiner's provisioned peer token is refused on `/api/sync/*`; sync starts automatically once
the vote passes. If the round is vetoed or expires, the provisioned credentials are revoked.

**Errors:** `401` for an invalid or expired handshake, `400` if `/apply` has not run for the session,
and `409` **`Network was removed while the handshake was in flight`** if the target network is deleted
between `/apply` and `/finalize`. The finalize commit re-reads the live config immediately before
writing, so a network removed mid-handshake fails cleanly rather than being silently recreated from a
stale snapshot.

---

### Check Invite Status

```http
GET /api/invite/status/:handshakeId
```

**Response** `200`:

```json
{ "status": "pending", "expiresAt": "2026-03-25T15:00:00.000Z" }
```

---
