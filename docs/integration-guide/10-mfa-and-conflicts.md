# MFA & Conflicts APIs

> Part of the [Ythril Integration Guide](../integration-guide.md).

## MFA API

Base path: `/api/mfa` — requires admin token.

### Check MFA Status

```http
GET /api/mfa/status
```

**Response** `200`:

```json
{ "enabled": false }
```

---

### Setup MFA

```http
POST /api/mfa/setup
```

**Response** `201`:

```json
{
  "secret": "JBSWY3DPEHPK3PXP",
  "otpauth": "otpauth://totp/Ythril:My%20Brain?secret=JBSWY3DPEHPK3PXP&issuer=Ythril"
}
```

Scan the `otpauth` URI as a QR code in any TOTP app. The issuer is always `Ythril`, and the account label is the instance label (`instanceLabel`, falling back to `brain`).

> When MFA is **already enabled**, `POST /api/mfa/setup` (rotating the secret) and `DELETE /api/mfa`
> (disabling) require a current TOTP code in the `X-TOTP-Code` header — a stolen admin PAT alone
> cannot replace or remove the second factor. First-time enrolment (MFA off) needs no code. If the
> authenticator is lost, remove `totpSecret` from `secrets.json` on the host to recover.
>
> **Codes are single-use.** A TOTP code is accepted once; replaying it — including within the ±1-step
> (up to 90 s) clock-skew window it would otherwise still match — is refused. `POST /api/mfa/verify`
> consumes the code too, so a code you tested there cannot immediately be reused for a gated call:
> wait for your authenticator to roll to the next one.

### Per-token MFA

The switch above is **instance-wide**, which makes it mutually exclusive with automation: once MFA is on,
every admin-gated call needs a TOTP code, and a scheduler cannot type one. Since the deployments most likely
to want MFA are exactly the ones that have automation, a token can override the instance setting — the same
way `readOnly` and `spaces` already qualify a token.

Set `mfa` when creating the token (`POST /api/tokens`):

| `mfa` | Behaviour |
|---|---|
| absent / `"inherit"` | Follow the instance switch. **This is what every existing token does**, so nothing changes for a deployment that does not use the field. |
| `"exempt"` | Never demand a code, even while MFA is enabled instance-wide. The automation case. |
| `"required"` | Always demand a code, even while MFA is switched off instance-wide. For the two human admin tokens on an instance that does not force it on everything. |

```http
POST /api/tokens
X-TOTP-Code: 123456
{ "name": "nightly-scan", "admin": true, "mfa": "exempt" }
```

**An exemption is a deliberate hole in an instance-wide control, so it cannot widen itself.** `POST
/api/tokens` is gated by admin + MFA — which an admin token that is *itself exempt* satisfies with no code at
all. Without a second rule, one exemption could mint another until the switch protected nothing. So while MFA
is enabled, **creating an exempt token requires a current `X-TOTP-Code` on that request regardless of who is
asking**; the refusal is `403 { "error": "MFA_REQUIRED" }` with a message naming the reason. Someone holding
the automation token but not the authenticator cannot escalate.

Exempt tokens are badged in **Settings → Tokens** and their creation is audited. Grant one to the narrowest
token that needs it — an exempt token is one factor away from the instance's admin surface, and `spaces` and
`readOnly` still apply to it.

---

### Verify OTP Code

```http
POST /api/mfa/verify
```

```json
{ "code": "123456" }
```

**Response** `200`:

```json
{ "valid": true }
```

---

### Disable MFA

```http
DELETE /api/mfa
```

**Response** `204`.

---

## Conflicts API

Base path: `/api/conflicts`

### List Conflicts

```http
GET /api/conflicts?spaceId=general
```

Returns `{ conflicts: [...], returned: <n>, truncated: <bool> }`. The list is bounded — capped per space
and to a total across all accessible spaces — so a token spanning many spaces cannot force an unbounded
response. When `truncated` is `true` the caller has **not** seen every conflict (resolve some and re-list to
see the rest); `returned` is how many were included. The `link-violations` list is bounded the same way.

---

### Get Conflict

```http
GET /api/conflicts/:id
```

---

### Resolve a Conflict

```http
POST /api/conflicts/:id/resolve
```

```json
{
  "action": "keep-local",
  "rename": "report-v2.pdf",
  "targetSpaceId": "archive"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `action` | yes | One of: `keep-local`, `keep-incoming`, `keep-both`, `save-to-space` |
| `rename` | no | New path for the conflict copy under `keep-both`, or the destination path in the target space for `save-to-space`. A string; an empty one is no rename |
| `targetSpaceId` | when `save-to-space` | Space the incoming file is **moved** into. A string naming a concrete space (a proxy space is `400`) |

| Action | Result |
|--------|--------|
| `keep-local` | Deletes the conflict copy, keeps your file |
| `keep-incoming` | Replaces your file with the conflict copy. The one action that replaces a file: your local one |
| `keep-both` | Keeps both files; with `rename`, moves the conflict copy to that path |
| `save-to-space` | **Moves** the conflict copy to another space (it leaves this one), removes the conflict |

`keep-both` with a `rename` and `save-to-space` put the copy where **you** chose, and they never replace what stands there:
a file, a directory, a symbolic link or a file record with no bytes yet (a peer's file whose content has not arrived) at
the destination is `409` with `code: "destination_exists"` and the destination's `path`. Nothing moves, and the conflict
stays open, so you can choose another name or space and resolve it again. A `rename` that goes through a file
(`a.txt/inside.txt`) is `409` with `code: "path_blocked"`. A `rename` that leaves the space, or goes through a link that does, is
`400`, and so is a `rename` into a path this instance keeps for itself (the conversion trees `_converted/` and `_extracted/`, a
schema snapshot, a conflict copy's own name). Every path of the conflict, the copy's and the original's, is resolved the same
checked way, so a conflict path that goes through a link out of the space is `400` for every action. `rename` and
`targetSpaceId` that are not strings are `400`, before any `403`.

`save-to-space` is a write of a file in the target space, so it needs `files:write` **there**, besides the data-quality
area that lets a token resolve conflicts. Without it the answer is `403`, the same whether or not anything stands at the
destination, so a token that may not write in a space cannot learn what the space holds.

A placement is one hard link and the removal of the copy's old name, and a crash between the two leaves the copy under
both names. Resolving the same conflict again finishes it (the old name is removed) and does not refuse the file as an
occupant of its own destination. A foreign process writing at the destination in the very instant of the placement is
the one window left, on a file system that cannot make a hard link; it is the same limit as a move's (`05-files-api`).

**Response** `200`:

```json
{ "status": "resolved" }
```

When there is nothing to place, the answer says so and still closes the record:

```json
{ "status": "resolved", "resolved": "nothing-to-place" }
```

That is: the conflict copy is already gone (an earlier resolution placed it and failed to close the record), `save-to-space`
into the conflict's own space at the same path, or a `keep-both` `rename` equal to the conflict path. Nothing was placed or
replaced, and a client must not report that something was. `resolved` is a word this answer may gain values for, so a client
must **treat any other `resolved` value as resolved**: the record is closed whatever the word says, and a word it does not
know is shown as it is or ignored, never read as a failure.

A stored conflict record whose path leads out of the space (an original or conflict path that goes through a link pointing
elsewhere) is `400` for every action, `keep-local` included, and no route clears such a record. That is cosmetic: nothing
outside the space was or is touched.

---

### Bulk Resolve Conflicts

```http
POST /api/conflicts/bulk-resolve
```

```json
{
  "ids": ["conflict-id-1", "conflict-id-2"],
  "action": "keep-local"
}
```

Accepts the same `action`, `rename`, and `targetSpaceId` fields as single resolve, under the same rules. Applies the action to all listed conflicts.
A `rename` shared by several ids is one destination, so the first conflict is placed there and the others are refused as occupied.
A malformed body, a `save-to-space` target the token may not write files in, and a proxy target are one `400` or `403` for the whole request;
a refusal about one conflict is that conflict's failure, and the rest are resolved.

`ids` holds at most **2 000** — the most the conflict list returns — and every entry must be a non-empty string.
More, or anything else, is a `400` naming `ids`: each id is looked up across every space you can write, one at a
time, so the count is the cost.

**Response** `200`:

```json
{
  "resolved": 1,
  "failed": [
    { "id": "conflict-id-2", "error": "'taken.txt' already exists where the copy would be placed, ...", "code": "destination_exists", "status": 409, "path": "taken.txt" }
  ]
}
```

A `failed[]` element is `{ id, error, code?, status?, path? }`. `error` is a sentence of the server's, never the file system's own
words (which name the server's data directory). A refusal of a file act carries its `code` (the same codes
[Files](05-files-api.md) lists, such as `destination_exists`), its HTTP `status` and, when it names one, the `path`; a conflict that does not exist is `{ id, error, status: 404 }`;
a path outside the space is `status: 400`. `code` is present only for a file act's answer. A copy that was already gone counts in `resolved`
(it closed the record), not in `failed`.

---

### List Link Violations

```http
GET /api/conflicts/link-violations
```

Returns sync-ingested documents that violate strict linkage rules.

**A reference is checked once its transfer is whole, and a dangling end is ONE record.** A pull checks the edges
and links it received after every record family of the space's transfer has landed — and still checks what landed
when a later family's fetch fails mid-cycle. A sender pushes one family per request, **targets first**: facts,
entities, chrono, file metadata, then edges, then links. So when an edge or a link is pushed, every record it may
point at that the same cycle carries is already here, and the push door checks after each request with the
families still to come in that order left unjudged. Either way, an edge to a chrono entry or a link to a file that
arrives in the same transfer is never recorded missing. A family whose transfer stopped early (a page cap, a failed
write, a failed fetch) leaves its targets unchecked that cycle. A violation's `_id` is derived from the document,
the field and the target, so receiving the same edge again adds no second record, and `link_violation.created` fires
once, for the new one.

**From a sender older than this release**, which pushes in the old order (edges before chrono entries, links
before file metadata), an edge to a chrono entry or a link to a file created in the same interval can still be
recorded missing; dismiss it once the target is here. The check runs after the push is answered, so a slow store
never holds the push past the sender's timeout.

`docType` is `entity`, `edge`, `fact`, `chrono` or **`file`**. A file's links are checked like any other
record's, so `docType: "file"` is a value a caller must expect — and for that one `docId` is the file's
**path** rather than a UUID, because that is what identifies a file in a space.

**Response** `200`:

```json
{
  "violations": [
    {
      "_id": "uuid",
      "spaceId": "general",
      "docId": "uuid",
      "docType": "edge",
      "field": "from",
      "reason": "from must be UUID v4 when strictLinkage is enabled",
      "peerInstanceId": "peer-uuid",
      "detectedAt": "2026-04-12T12:00:00.000Z"
    },
    {
      "_id": "uuid",
      "spaceId": "general",
      "docId": "handbook/onboarding.md",
      "docType": "file",
      "field": "file.entity",
      "reason": "file.entity references non-existent entity '…'",
      "peerInstanceId": "peer-uuid",
      "detectedAt": "2026-04-12T12:00:00.000Z"
    }
  ]
}
```

---

### Dismiss a Link Violation

```http
DELETE /api/conflicts/link-violations/:id
```

**Response** `204` when dismissed, `404` when not found.

---

### Dismiss All Link Violations

```http
DELETE /api/conflicts/link-violations
```

**Response** `200`:

```json
{ "dismissed": 12 }
```

---

### Seed a Conflict (Testing Utility)

```http
POST /api/conflicts/seed
Authorization: Bearer <admin-token>
```

Creates a synthetic conflict record for test scenarios. **Admin only** (`requireAdmin`) — a non-admin token, even one with access to the space, gets `403 "Admin token required"`.

```json
{
  "_id": "conflict-id",
  "spaceId": "general",
  "originalPath": "docs/file.md",
  "conflictPath": "docs/file.conflict.md",
  "peerInstanceId": "peer-uuid",
  "peerInstanceLabel": "Peer Brain",
  "detectedAt": "2026-04-15T10:00:00.000Z"
}
```

**Response** `201`:

```json
{ "id": "conflict-id" }
```

If the authenticated token has no access to `spaceId`, response is `403`.

---
