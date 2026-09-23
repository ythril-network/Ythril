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
| `rename` | no | New filename for `keep-both`, or destination path for `save-to-space` |
| `targetSpaceId` | when `save-to-space` | Space to copy the incoming file into |

| Action | Result |
|--------|--------|
| `keep-local` | Deletes the conflict copy, keeps your file |
| `keep-incoming` | Replaces your file with the conflict copy |
| `keep-both` | Keeps both files; optionally renames the conflict copy |
| `save-to-space` | Copies the conflict file to another space, removes the conflict |

**Response** `200`:

```json
{ "status": "resolved" }
```

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

Accepts the same `action`, `rename`, and `targetSpaceId` fields as single resolve. Applies the action to all listed conflicts.

**Response** `200`:

```json
{
  "resolved": 2,
  "failed": []
}
```

---

### Dismiss a Conflict

```http
DELETE /api/conflicts/:id
```

Removes the conflict record without touching any files.

**Response** `204`.

---

### List Link Violations

```http
GET /api/conflicts/link-violations
```

Returns sync-ingested documents that violate strict linkage rules.

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
