# Tokens API

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Tokens API

Base path: `/api/tokens`.

- `GET /api/tokens/me` requires any valid token.
- The read-only list `GET /api/tokens` requires an **admin** token (but not MFA).
- All **mutating** token routes (create/rename/delete/regenerate) require admin scope **and** MFA where enabled.
- A **space-restricted administrator** is admitted by those guards and then narrowed: every one of them resolves the caller's scope and refuses a token that reaches spaces outside it. That holds for reading the list (fewer rows), minting (an out-of-scope grant is refused), editing, **rotating** and **revoking** — the last two only from this release.

### Current Token Context

```http
GET /api/tokens/me
```

Returns the effective identity and permissions of the caller token.

**Response** `200`:

```json
{
  "id": "tok_abc123",
  "name": "MCP Agent",
  "prefix": "abc123",
  "admin": false,
  "readOnly": false,
  "spaces": ["general", "research"],
  "createdAt": "2026-01-15T10:00:00.000Z",
  "lastUsed": "2026-07-20T09:30:00.000Z",
  "expiresAt": null
}
```

Returns the full stored token record minus its `hash`. Besides the fields above it also includes `peerInstanceId`, `schemaLibrary`, and `oauthClientId` when those apply to the token.

---

### What a right grants

```http
GET /api/tokens/rights-catalog
Authorization: Bearer <token>
```

**Authenticated, not admin** — the caller who most needs this is one reading the rights they themselves hold.

```json
{
  "areas": ["knowledge", "files", "schema", "dataQuality", "networks"],
  "rungs": ["none", "read", "write", "admin"],
  "implications": [
    { "when": "knowledge", "atLeast": "write", "grants": "schema", "rung": "read" }
  ],
  "derivedRungs": [
    { "id": "spaceAdmin",
      "requires": { "knowledge": "admin", "files": "admin", "schema": "admin", "dataQuality": "admin" },
      "grants": "That space’s own tokens (listing, minting and editing) and that space’s own settings, schema and index rebuilds.",
      "excludes": "Nothing instance-shaped: it cannot grant `instanceAdmin` or `createSpaces`, cannot set a floor, and cannot reach, mint for, or edit tokens for any space it does not administer — it does not even list them." }
  ],
  "routes": [
    { "area": "knowledge", "method": "POST", "route": "/api/brain/recall", "needs": "read" },
    { "area": "files", "method": "DELETE", "route": "/api/files/:spaceId", "needs": "write" }
  ],
  "notAreaScoped": [
    { "route": "/api/spaces/:id/rename",
      "why": "Renaming a space is Space-admin, which is a column in the approved design but not one of the four DATA areas this inventory covers." }
  ]
}
```

**The `networks` area** (since F-34) governs sharing a space with other instances, per space:

| rung | what it lets a token do |
|---|---|
| `read` | see a network that carries the space — listed, and readable by id |
| `write` | create a network with the space, and leave a membership **it** established |
| `admin` | change a network's settings, and leave a membership **any** token established |

A network carries several spaces, so an act on it needs the rung on **every** space it carries; one short is
refused with a `403` naming it. A network you may not see is a `404`, never a `403`. A membership that predates
the column has no recorded establisher, so leaving it needs `admin`. Space admin (`spaceAdmin`) does not grant the
`networks` cells — `derivedRungs[spaceAdmin].requires` still names the four data areas — but since F-37 it is
**enough for the two acts that share its own spaces**: a token administering every space an act touches may create
a network with them, join one mapped onto them (onto a new space too, with `createSpaces`), see it, and generate
its invite. Otherwise joining a *remote* network needs `write` — and `createSpaces` plus a floor of `write` for any
space the join would create. Peers, topology, votes and sync stay instance-admin, and so do invites except for that
space admin.

**`networks` is optional in a matrix body and `none` when absent**, so a client written before it existed keeps
minting four-area matrices. Every other area is required; an unknown area name is a `400`.

This is the table the server **enforces** against, not a description of it, so it cannot disagree with the gate.
Use it instead of maintaining your own map of rights to endpoints.

**`needs` is the lowest sufficient rung, and rungs contain the ones below.** So the endpoints reachable at
`write` are every route in that area whose `needs` is `read` *or* `write` — filter with
`rungs.indexOf(needs) <= rungs.indexOf(yourRung)`. A list of only the routes whose `needs` equals your rung
would understate what you hold.

`none` reaches nothing, and no route is ever listed with `needs: "none"`.

#### `implications` — a rung one area gives another

One area's rung can entail a rung in another, **in the same space**. Today there is exactly one rule: a token
holding `knowledge: write` also holds `schema: read`, because writing a record against a schema requires
reading that schema, so the pair is not an operator's to get wrong.

Read the rule as: *when `when` is at `atLeast` or higher, `grants` is held at no less than `rung`.*

Three properties worth building against:

- **It is a floor, never an assignment.** A `schema` rung granted outright is never lowered by it.
- **It does not chain.** Each rule is evaluated against what was *granted*, never against another rule's
  inference, so the order of the array is not load-bearing.
- **It is scoped to one space**, and applies to the all-spaces floor within the floor's own scope.

#### `derivedRungs` — the rungs beyond the four areas

**A space administrator holds `admin` in all four areas of one space.** Since 5.0 that is something you can
**grant directly**, with `spaceAdmin` on the rights matrix:

```json
{
  "instanceAdmin": false,
  "createSpaces": false,
  "floor": null,
  "perSpace": {},
  "spaceAdmin": ["work"]
}
```

`requires` is what the grant RESOLVES TO, `grants` is what it unlocks **beyond** what the four rungs already
give, and `excludes` is the containment. Read `excludes` if you are building against it: **it is never
instance-wide.** It cannot grant `instanceAdmin` or `createSpaces`, cannot set an all-spaces floor, and
cannot reach, mint for or edit tokens for any space it does not administer — it does not even list them.
Those rules are red-teamed, not aspirational.

**The four rungs still work and nothing was migrated.** A token whose four areas are all at `admin` for a
space administers it exactly as before. The two spellings are one right: the server resolves `spaceAdmin`
into `admin` in every area of the named space before any check runs, so no code compares the two and neither
can disagree with the other. Send whichever you have; read both.

**What it does NOT touch is the floor.** `spaceAdmin` names spaces. A floor reaches every space including
ones created later, so it stays its own field — granting a space administrator the floor would be granting
them the instance.

> **This section used to say the opposite**, in as many words: *"There is no `spaceAdmin: true` field on a
> token and there will not be — the four rungs already express it, and a second field could disagree with
> them."* The second half of that was the real objection and it is what the design answers: a field
> **checked beside** the rungs can disagree with them, and a field they are **resolved from** cannot.

To show it in your own UI: read `derivedRungs`, then compare a token's effective rung per area (after
`implications`) against `requires`.

**That is what our own matrix does since 3.2.0**, and it is worth saying because the field existed for several
releases before anything read it: the `Space admin` column is computed from the four displayed rungs, and setting
it writes all four areas in ONE update rather than four. Compare against the DISPLAYED rung, not the stored one —
a row that reaches admin through the floor is administered, and a column reading the stored matrix would
contradict the cells beside it. Write the whole row at once for the same reason a patch is whole: four sequential
updates let a reader observe three intermediate states that nobody asked for.

The stored matrix is *not* rewritten — `GET /api/tokens` returns what was set. Resolve the effective rung by
applying this table on read; do not persist the result, or a rung that exists only while `knowledge` is
`write` will outlive it being lowered.

The same resolution governs both doors. A capability refused over REST is refused over MCP for the identical
reason, because `effectiveRung` is the single place either surface asks what a token holds.

#### `notAreaScoped` — the space-scoped routes NO area governs

Some space-scoped routes are deliberately outside the four data areas, and each carries the reason. Renaming a
space is Space-admin. Reading which tokens reach a space is a read of **auth** state, not of the space's
contents. Per-space usage counters are instance observability that happens to be keyed by space.

**Why this is published rather than left implicit.** A route absent from `routes` used to be indistinguishable
from one nobody had classified — so "the matrix does not govern renaming" was a fact only the server's source
held, and a grid of four areas read as complete while three routes sat outside all of them. Same argument as
`routes` itself: the list the server decides from is the only description of a right that cannot be wrong.

**No `method`, unlike `routes`.** An exemption is a claim about what the route *is*, so it covers every verb on
that path. `routes` keys on method + path because `GET` and `DELETE` genuinely need different rungs; an
exemption does not have that shape.

**What it does not mean.** Not "unauthenticated", and not "ungoverned". Reach is still enforced — a token that
cannot touch the space cannot call these either — and each route keeps its own guard, which for all of them
today is admin or space-admin. What the field says is only that *the four-area grid* is not the thing deciding.

Absent on a server that predates the field. Read that as an empty list, never as an error.

---

### List Tokens

```http
GET /api/tokens
```

**Response** `200`:

```json
{
  "tokens": [
    {
      "id": "tok_abc123",
      "name": "Admin",
      "prefix": "ythril_b",
      "createdAt": "2026-03-25T14:00:00.000Z",
      "lastUsed": "2026-03-25T15:30:00.000Z",
      "expiresAt": null,
      "spaces": null,
      "admin": true
    }
  ]
}
```

Note: `hash` is never exposed.

---

### Create a Token

```http
POST /api/tokens
```

```json
{
  "name": "MCP Agent",
  "rights": {
    "instanceAdmin": false,
    "createSpaces": false,
    "floor": null,
    "perSpace": {
      "general": { "knowledge": "write", "files": "write", "schema": "read", "dataQuality": "read" },
      "research": { "knowledge": "read", "files": "read", "schema": "read", "dataQuality": "none" }
    }
  },
  "expiresAt": "2027-01-01T00:00:00.000Z"
}
```

**Fields:**

| Field | Notes |
|---|---|
| `name` | Required. Human-readable label. |
| `rights` | The per-space permission matrix. **This is how scope, admin and read-only are all expressed since 4.0** — see *The three fields 4.0 removed* below. |
| `expiresAt` | ISO 8601 expiry timestamp. Omit for non-expiring. |
| `peerInstanceId` | Bind this token to a network peer (UUID). Required for tokens a peer will present on the `/api/sync/*` **data-write** endpoints in manually-configured networks — the invite handshake sets it automatically. Peer identity is server-issued and cannot be self-declared by the caller. |
| `schemaLibrary` | `true` to issue a **library access token**. See below. |

#### The three fields 4.0 removed

**`POST /api/tokens` no longer accepts `spaces`, `admin` or `readOnly`.** Sending any of them is a `400`
naming its replacement:

| Removed | Send instead |
|---|---|
| `spaces: ['a','b']` | `rights.perSpace`, keyed by space id |
| `admin: true` | `rights.instanceAdmin: true` |
| `readOnly: true` | `rights.floor` with read rungs |

The matrix has been the permission model since 2.6 and can express everything the three could — that is
not a claim, it is what the upgrade path does: every pre-matrix token has its matrix derived from exactly
those three fields, and a check holds that derivation to never granting more than the original.

**The refusal names the replacement rather than answering *unrecognised field*.** A strict schema alone
would tell you that you are wrong without telling you what to do, on the endpoint most integrations meet
first.

**Existing tokens keep working, and the reason is not the one this paragraph used to give.** It said the
old fields *"are still honoured"*. They are not read at all. `spaces`, `admin` and `readOnly` left the token
record in 3.1, and 4.0 removed the last place anything fell back to them: **a token that reaches this
instance with no rights matrix now reaches nothing.** There is no legacy path left to be honoured.

What keeps a pre-matrix token working is that it never arrives without a matrix. One is derived from those
three fields **in memory, on every start**, and every other way a token comes into being carries one
already — a personal access token gets one when it is created, and an OIDC session carries one per request
from its claim mapping. The fields may still sit in `config.json`; nothing enforces from them.

**Why the fallback went rather than staying as a safety net.** It read an ABSENT allowlist as *unrestricted*,
so a token carrying neither a matrix nor an allowlist would have been handed every space on the instance.
Nothing could reach that branch — which is the worse of the two ways to be unreachable, because nothing
exercises it and anything that ever did would be given everything.

**One behaviour changed with them, and it was a defect rather than a policy.** A space-restricted
administrator minting a token was refused unless the body carried a `spaces` array — so a matrix-only
request, which is what this product's own interface sends, was read as unrestricted and refused with a
message about being unrestricted. The mint route now decides *outside your scope* with the same function
the edit routes use.

> **`readOnly` is no longer STORED on a token — 3.1 — and 4.0 stopped accepting it as INPUT.** Two changes,
> a release apart, and only the second one is visible to you: **sending `readOnly` to `POST /api/tokens` is
> now a `400`**, as the table above says. Write `rights.floor` with read rungs instead. This note said
> *"nothing you send or read changes"*, which was true of the 3.1 half alone.
>
> **What you READ is unchanged.** The token responses still carry `readOnly`. What changed there is where
> the answer comes from — the rights matrix rather than a separate boolean on the record.
>
> Nothing had decided on that boolean since 3.0, because every write check reads the matrix. Keeping it
> stored alongside meant two spellings of one fact, with the older one free to drift.
>
> **The returned value is now derived**: a token is read-only exactly when its matrix grants no write rung
> anywhere. That is also correct for a token nobody ever set the flag on but which holds only `read` — a case
> the stored boolean could not express and answered `false` for. Tokens created before 3.1 keep their scope:
> the load-time migration still reads the stored flag to derive their matrix.
>
> `spaces` said *"unchanged for now, and follows separately"* here. It followed: 4.0 refuses it on this
> route with the other two.

<!-- markdownlint-disable-next-line MD028 -->

> **`admin` is no longer STORED either — 3.1 — and 4.0 stopped accepting it as input, exactly as `readOnly`
> did.** Sending it to `POST /api/tokens` is a `400`; write `rights.instanceAdmin: true` instead. Responses
> still carry `admin`, derived from `rights.instanceAdmin`, so what you READ is unchanged.
>
> **If you branch on it, read `rights.instanceAdmin`.** And note what it is *not*: holding the `admin` rung
> in every space is a different thing. That grants those spaces, and says nothing about spaces created
> tomorrow or about instance-shaped routes like creating a space or joining a network — only `instanceAdmin`
> or an all-spaces floor does.
>
> **OIDC sessions are unaffected.** They are built per request from a claim mapping and carry no matrix, so
> the flag is where their answer legitimately lives; every admin check falls back to it for exactly that case.

**Response** `201`:

```json
{
  "token": { "id": "...", "name": "MCP Agent", "prefix": "ythril_x", ... },
  "plaintext": "ythril_xK9mPq..."
}
```

> **Two keys, and only one of them is a credential.**
>
> | key | what it is |
> |---|---|
> | `token` | **The record**, not the secret — id, name, prefix, flags, scoping. Safe to log, store and display. It carries no credential. |
> | `plaintext` | **The secret.** Shown once, never retrievable again. Treat it as you would a password. |
>
> The names invite the opposite reading, and an integrator made it: they took the field called `token`,
> wrote it into a handover file, and rendered the actual secret to a terminal — then revoked and re-minted
> rather than reason about the exposure. The mistake is silent, so nothing tells you it happened.
>
> `prefix` on the record is the first characters of the secret, kept so a token can be identified in a list.
> It is not enough to authenticate with, and it is the only part of the secret the record contains.
>
> Every other route reinforces the misleading reading: `PATCH /api/tokens/:id` returns `{ "token": … }` and
> `GET /api/tokens` lists records under the same word — all metadata, never a credential.
> `POST /api/tokens/:id/regenerate` is the one that cannot be misread: it returns `{ "plaintext": … }` alone.

#### Library Access Tokens

A **library access token** (`schemaLibrary: true`) grants read-only access to the public schema library endpoints (`GET /api/schema-library/public*`) only. It cannot access brain data, files, MCP tools, or any space.

```json
{ "name": "Remote Catalog Reader", "schemaLibrary": true }
```

Use cases:

- The remote instance's `/public` endpoint is behind an auth proxy (Cloudflare Access, nginx auth, etc.) that requires a Bearer token.
- A consumer instance adds a foreign catalog and stores this token as the catalog's `accessToken`. It is forwarded as `Authorization: Bearer` on every catalog browse request.

Constraints: `admin` must be `false`/omitted; `spaces` must be empty/omitted. The token is always `readOnly: true` — this cannot be overridden. Multiple library access tokens may coexist.

---

### Regenerate a Token

```http
POST /api/tokens/:id/regenerate
```

Issues a new plaintext credential for an existing token record. The old value is invalidated.

**Response** `200`:

```json
{ "plaintext": "ythril_newValue..." }
```

---

### Edit a Token

```http
PATCH /api/tokens/:id
{ "name": "new label" }
```

Three fields are editable: **`name`** (1–200 chars, same bound as create), **`rights`** (the per-space matrix
— see [Create a Token](#create-a-token) for the shape and the capping rules), and **`mfa`**
(`inherit` | `exempt` | `required`). Send any combination. The secret and the expiry are untouched; use
regenerate to rotate the secret. Audited as `token.update`, with the second factor recorded on both sides of
the diff.

> **A SPACE-RESTRICTED administrator may edit only its own spaces' rows.** An admin token that carries a `spaces`
> allowlist is admitted here, and then held to a narrower rule than an unrestricted admin:
>
> - it may set `rights.perSpace[X]` only for spaces X in its own allowlist;
> - it may **never** set `instanceAdmin` or `createSpaces`;
> - it may **never** set `floor` — a floor applies to every space *including ones that do not exist yet*, so however
>   modest its rungs look, it is instance-wide in effect. It is refused rather than capped, because there is no
>   per-space version of it to cap to;
> - it may only edit a token whose own `spaces` are all inside its allowlist. Editing an **unrestricted** token is
>   refused, because such a token reaches every space by definition.
>
> Each refusal answers `403` with a `refusals` array naming what was rejected, so a client can report the specific
> reason rather than "forbidden". This mirrors the rule `POST /api/tokens` already applies to a space-restricted
> creator. An unrestricted admin is unaffected.
>
> **`GET /api/tokens` is scoped the same way**: a space-restricted caller sees only the tokens it could edit.

<!-- markdownlint-disable-next-line MD028 -->

> **The SPACE ADMINISTRATOR, and how it differs from the legacy pair above.** The paragraph above describes an
> `admin: true` token carrying a `spaces` allowlist. The matrix expresses the same role without the legacy
> flag: a token holding the `admin` rung on **all four areas** (`knowledge`, `files`, `schema`, `dataQuality`)
> of space X is X's administrator.
>
> All four, not any one — `admin` on Files alone would otherwise mint tokens, which is an escalation rather
> than a role.
>
> Such a token reaches the token routes and is then held to exactly the rules above, scoped to the spaces it
> administers. It also reaches **its own space's settings** — see
> [Update a Space](06-spaces-api.md#update-a-space) for which routes and which single field is refused.
>
> What it never reaches is anything instance-shaped: creating a space, joining a network, instance settings,
> the database page. There is no space to scope those to, which is what makes them the instance's.

<!-- markdownlint-disable-next-line MD028 -->

> **Granting `mfa: "exempt"` costs a live TOTP code on the request** whenever MFA is enabled instance-wide —
> the same rule create has, and for the same reason. Admin authentication here is satisfied by an admin token
> that is itself exempt, so without it one exemption could grant the next until the instance-wide switch
> protected nothing. Send the code as `x-totp-code`; without it the answer is `403 MFA_REQUIRED`. The check
> runs before anything is written, so a refused exemption never leaves a half-applied edit.

**Response** `200`: the updated token record (hash excluded).

```json
{ "token": { "id": "…", "name": "new label", "admin": false, "...": "…" } }
```

#### Sending a token you read back

The response carries the whole record. You can PATCH that record straight back — the fields this route does
not edit are accepted **as long as they are unchanged**, so read-modify-write works without stripping
anything first:

```http
GET  /api/tokens          →  { "tokens": [ { "id": "t_1", "name": "old", "spaces": ["qa"], … } ] }
PATCH /api/tokens/t_1        { "id": "t_1", "name": "new", "spaces": ["qa"], … }   →  200
```

Changing one of those fields is a `400` that names what to write instead, rather than being silently
dropped:

```json
{ "error": "Cannot change `spaces` on this route. For `spaces`, set `rights.perSpace` (or `rights.floor` for every space). Sending these fields UNCHANGED is fine — a token you read back round-trips." }
```

`spaces`, `admin` and `readOnly` are the pre-2.6.0 scope model; their replacement is `rights`. The rest
(`createdAt`, `lastUsed`, `expiresAt`, `peerInstanceId`, `schemaLibrary`, `oauthClientId`) are set
when the token is minted and are not editable on any route.

A field name this route has never heard of is still a `400` — a mis-spelled `spaceIds` must not be accepted
and dropped.

Returns `404` if no token has that id, `400` for an empty/oversized name or a body that changes nothing.

---

### Revoke a Token

```http
DELETE /api/tokens/:id
```

**Response** `204`.

| Refusal | Meaning |
| --- | --- |
| `404` | no token with that id |
| `403` | you are a **space-restricted administrator** and this token reaches spaces outside your scope. The body carries `refusals` naming which — the same shape `PATCH` answers with |
| `409` | it is the instance's last administrator token |
| `500` | the token was listed but could not be removed, and **is still valid**. A server-side inconsistency between the token list and the stored config; retrying will not help |

**The `403` and the `500` are both new.** Until this release the route resolved no scope at all, so an
administrator of one space could revoke any token on the instance — including instance-admin tokens and tokens
for spaces it cannot see. And it discarded the outcome of the removal, answering `204` even when nothing was
deleted, which told a caller a live credential was gone.

**The scope refusal is answered before the last-admin check**, deliberately: the other order would tell a
caller whether a token it may not touch is the instance's only administrator.

`POST /api/tokens/:id/regenerate` narrows the same way and for the same reason — rotation invalidates the old
secret instantly and hands the replacement only to the caller, so it is as destructive as revocation and
quieter about it.

---
