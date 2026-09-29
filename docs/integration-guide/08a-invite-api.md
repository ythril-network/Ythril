# Invite API

> Part of the [Ythril Integration Guide](../integration-guide.md).

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
  "spaces": ["general", "y-project-template"],
  "networkSpaces": ["general", "y-twin"],
  "inviteCode": "ythril1_eyJoYW5kc2hha2VJZCI6..."
}
```

`spaces` is what this instance calls each space the network carries, `networkSpaces` (index-aligned, since 5.6.0)
what the network calls it; they differ for a space renamed here. The redeem answer (`POST /api/invite/redeem`) has
the same two fields.

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

**And the token it replaces is revoked** (`Q-163`). Once a handshake completes — on the inviter at `finalize`, on the
joiner when `finalize` answers, and on both sides of a club pairing — every other live token this instance gave that
peer is revoked, because the peer can no longer present it. They used to stay valid until the two shared no network
at all, so each join left one more behind. A token still in a handshake keeps its expiry and is never revoked this
way, since two joins with one peer can overlap. At start an instance also revokes the ones left from before: tokens a
newer one with the same peer replaced, and that the peer has not presented since.

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
  "spaces": ["general", "y-project-template"],
  "networkSpaces": ["general", "y-twin"]
}
```

`spaces` is what the inviter calls each space; `networkSpaces`, index-aligned, is what the network calls it — they
differ for a space the inviter renamed (here `y-twin` → `y-project-template`). See
[Join Remote](08-networks-api.md#join-remote-rsa-handshake) for what a joiner does with the pair.

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
