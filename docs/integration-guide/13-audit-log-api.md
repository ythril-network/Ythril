# Audit Log API

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Audit Log API

Base path: `/api/admin/audit-log` — **requires admin token** on all endpoints.

Ythril maintains an append-only, immutable audit log of every authenticated API operation. The log captures who performed what action, when, on which space, and the resulting HTTP status — providing a full access trail for compliance and security review.

**MCP tool calls are in it, under the same operation names as REST.** An agent calling `remember`
produces a `memory.create` entry, exactly as `POST /api/brain/spaces/:id/memories` does — so a query for
"who created this memory" does not have to know which transport was used. The transport is recorded
separately: `method` is `MCP` and `path` is `http:<tool>`. Entries written before 4.0 can also carry
`sse:<tool>` — the SSE transport was removed in that release, so `sse:` is a fact about when an entry was
written, not a transport a client can still use.

A tool that refuses the call (a schema violation, a scope rejection) is recorded with status **422**. MCP
answers 200 at the transport layer even when the tool errors, so a status taken from the HTTP response
would log every rejected write as a success.

Read tools (`query`, `recall`, `traverse`, `list_*`, `read_file`, …) follow the same rule as REST reads —
recorded only when `audit.logReads` is on. Three tools record nothing at all and say why in
`server/src/mcp/audit-map.ts`: `help` (returns this instance's own documentation), and `list_peers`
(reads local config, with no REST counterpart that is audited either).

⚠️ **Before 2.2.1, no MCP tool call was audited.** If you are reconstructing a history that crosses that
boundary, the absence of agent writes from earlier entries is not evidence they did not happen.

**Second-factor changes are in it.** `mfa.enable` records enrolment *and* a rotation of the secret;
`mfa.disable` records the second factor being removed from every admin mutation. Checking a code
(`POST /api/mfa/verify`) changes nothing and is deliberately not logged — it is also what a health check
calls repeatedly. Both mutations were unaudited before 2.2.1; if you are reconstructing a history that
crosses that boundary, their absence from earlier entries is not evidence they did not happen.

### What changed (`changes`)

Some operations additionally record the field values they altered:

```json
"changes": [
  { "field": "label", "from": "General", "to": "Renamed Workspace" },
  { "field": "strictLinkage", "to": true }
]
```

**Only explicitly allowlisted fields are ever recorded, per operation.** This is deliberate and it is the
opposite of redaction: audit entries are readable by any admin and retained for `retentionDays`, and several
audited routes handle credentials (token create/regenerate, webhook targets and signing secrets, model API
keys). Diffing a request body and stripping known-secret names would mean that forgetting one name writes a
live key into long-lived storage. Listing what *may* be recorded means forgetting one simply omits it.

Consequences worth knowing when reading the log:

- An operation with no allowlist has **no `changes` field at all** — absence means "not recorded", never
  "nothing changed".
- Values are **scalars**. A field whose value is an object or array is skipped rather than serialised.
- `from` absent means the field did not previously exist; `from: null` means it existed and was null.
- A request that **failed** (status ≥ 400) records no changes, because it changed nothing.

Currently allowlisted: `space.update`. Coverage expands per release; token and webhook operations are
excluded by design, since the interesting value in those payloads is the secret itself.

### Configuration

Add an `audit` block to `config.json`:

```json
{
  "audit": {
    "logReads": false,
    "retentionDays": 90,
    "recordChangeRetentionDays": 14
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `logReads` | `boolean` | `false` | When `true`, read operations (recall, query, list, traverse, stats) are also logged. By default only write operations and auth failures are recorded. |
| `retentionDays` | `number` | `90` | Number of days before audit entries are automatically purged by MongoDB's TTL daemon. |
| `recordChangeRetentionDays` | `number` | `14` | Days a **brain record edit's** `changes` payload survives before being redacted. See below. |

#### Why record changes expire sooner than the entries that carry them

An audit entry answers *who changed what, when, and through which route*. For admin and configuration
operations the `changes` payload is part of that answer — a label, a cron schedule, a `requireSignedVotes`
boolean — and it keeps the full `retentionDays`.

For **brain record edits** (`memory.update`, `entity.update`, `edge.update`, `chrono.update`,
`file.meta.update`, `entity.merge`) the payload is different in kind: it contains user content, the old text
of a memory or the previous description of an entity. That is a copy of your data in a second store with
different access rules — any admin can read the audit log, including for spaces their token could not
otherwise reach.

So the payload alone expires early. A background sweep unsets `changes` on those entries once they pass
`recordChangeRetentionDays` and marks them `changesRedacted: true`. **The entry itself is never shortened** —
who edited that memory and when remains answerable for the full retention period. Only "and here is what it
used to say" ages out.

`changesRedacted` exists so a reader can distinguish *"this operation records no changes"* from *"it did, and
they have expired"*. Without it an absent `changes` would quietly imply nothing was ever captured.

> **Upgrading from 2.6.0 or earlier: expect one large redaction, once.** The sweep was pointed at the wrong
> collection name from the release it was introduced in (2.0.0) until 2.6.1, so it matched nothing and this
> window was never enforced — record-edit `changes` kept their content for the full `retentionDays` instead.
> After upgrading, the first sweep redacts everything that had accumulated past the window in a single pass,
> and logs the count. A four-figure number there is the backlog, not a fault.
>
> The sweep now also logs its first pass of each process even when it redacts nothing, naming the collection
> and how many record-edit entries it can see. That line is what makes "working" distinguishable from
> "pointed at nothing" — the two were identical before, because an update against a collection that does not
> exist succeeds and reports zero.

#### What a record edit records

| Operation | Recorded fields |
|---|---|
| `memory.update` | `fact`, `description`, `type`, `tags`, `entityIds` |
| `entity.update` | `name`, `type`, `description`, `tags` |
| `edge.update` | `label`, `from`, `to`, `weight`, `type` |
| `chrono.update` | `title`, `description`, `type`, `status`, `startsAt`, `endsAt`, `tags`, `entityIds`, `memoryIds` |
| `file.meta.update` | `description`, `tags`, `entityIds`, `chronoIds`, `memoryIds` |
| `entity.merge` | `absorbedName` (recorded as name → `null`) |

A merge is a deletion wearing an edit's clothes. The entry already carries the survivor's id, and the request
path carries the absorbed one — but an id means nothing once the record it pointed at is gone, so the
absorbed entity's **name** is recorded as it disappears.

**`properties` is never recorded, for any record type.** It is a free-form bag whose keys you choose, so it
is the one field on a record that could hold a pasted credential — and an allowlist cannot vet names it has
never seen.

List-valued fields (`tags`, `entityIds`, `memoryIds`) are recorded as what moved rather than as the whole
list, so re-tagging one memory does not copy forty tags into the log twice:

```json
{ "field": "tags", "added": ["urgent"], "removed": ["draft"] }
```

Reordering a list records nothing — these are compared as sets. A list containing anything other than a
string, number or boolean is dropped entirely rather than partially recorded.

Only **single-record** edits carry changes. `POST /api/brain/spaces/:id/bulk` is a separate operation with
no change allowlist, and records arriving via peer sync never pass through these routes at all — so bulk
paths do not fill the audit log with content.

### Tracked operations

Audit entries are recorded for all write operations and (when `logReads` is enabled) read operations across the API surface:

| Category | Operations |
|----------|-----------|
| Memory | `memory.create`, `memory.update`, `memory.delete`, `memory.list` |
| Entity | `entity.create`, `entity.update`, `entity.delete`, `entity.list` |
| Edge | `edge.create`, `edge.update`, `edge.delete`, `edge.list` |
| Chrono | `chrono.create`, `chrono.update`, `chrono.delete`, `chrono.list` |
| File | `file.create`, `file.update`, `file.delete`, `file.read`, `file.list` |
| Space | `space.create`, `space.update`, `space.delete`, `space.wipe`, `space.list` |
| Token | `token.create`, `token.delete` |
| Webhook | `webhook.create`, `webhook.update`, `webhook.delete`, `webhook.test` |
| Brain | `brain.recall`, `brain.recall_global`, `brain.query`, `brain.find_similar`, `brain.stats`, `brain.er_model`, `brain.bulk_write`, `brain.traverse` |
| Network | `network.create`, `network.update`, `network.delete`, `network.join_remote`, `network.invite`, `network.member.add`, `network.member.remove`, **`network.invite.generate`** (an admin producing join material), **`network.member.join`** (the moment another instance becomes a member of a network on this one — the invite handshake's `finalize`) |
| Config | `config.reload` |
| Audit | `audit.export` — taking a copy of the whole record. Logged even when `logReads` is off |
| Auth | `auth.failed` (invalid or expired tokens on any endpoint) |

**An MCP tool logs the same operation as the REST route it mirrors**, so a filter finds the capability
rather than the door. `find_similar` was the exception until 4.4: it logged `entity.list` while
`POST /api/brain/spaces/:id/find-similar` logged `brain.find_similar`, so filtering for the latter showed
only REST calls and filtering the former mixed similarity searches into entity listings.

One pair still differs on purpose. `get_space_meta` logs `space.list`, because `GET /api/spaces/:id/meta`
has no operation of its own for it to agree with.

### Query audit log

```http
GET /api/admin/audit-log
Authorization: Bearer <admin-token>
```

All query params are optional:

| Parameter | Type | Description |
|-----------|------|-------------|
| `after` | `string` | ISO-8601 timestamp — entries from this time onward |
| `before` | `string` | ISO-8601 timestamp — entries up to this time |
| `requestId` | `string` | Exact `X-Request-Id` — the one row that request produced. Matched exactly, never as a prefix: a partial match would return somebody else's request while looking like a helpful search. Applies to the export below too |
| `tokenId` | `string` | Filter by token ID |
| `oidcSubject` | `string` | Filter by OIDC subject claim |
| `spaceId` | `string` | Filter by space ID |
| `operation` | `string` | Comma-separated operation names (e.g. `memory.create,entity.delete`) |
| `status` | `number` | Filter by HTTP status code |
| `ip` | `string` | Filter by client IP address |
| `limit` | `number` | Results per page (1–1000, default 100) |
| `offset` | `number` | Pagination offset (default 0) |

#### `requestId` joins this row to the server log

Every log line a request's own work produces carries the same `X-Request-Id` the response returned — see
[Correlating a failure with its log line](11-setup-api.md). So an operator holding an id from a bug report can
ask for the audit row *and* grep the log with one value, instead of two searches that cannot be joined.

**An absent `requestId` means the entry was written before the field existed — never that there was no request.**
Every audit entry has a request behind it; that is what the audit log is. The admin UI says so explicitly rather
than rendering a blank, and an integration should do the same.

**Response** `200`:

```json
{
  "entries": [
    {
      "_id": "a1b2c3d4-...",
      "timestamp": "2026-04-12T14:32:10.123Z",
      "requestId": "6f1c2d3e-...",
      "tokenId": "tok_abc123",
      "tokenLabel": "mcp-bridge",
      "authMethod": "pat",
      "oidcSubject": null,
      "ip": "192.168.1.10",
      "method": "POST",
      "path": "/api/brain/spaces/eng-kb/memories",
      "spaceId": "eng-kb",
      "operation": "memory.create",
      "status": 201,
      "entryId": "f7e6d5c4-...",
      "durationMs": 12
    }
  ],
  "total": 1847,
  "hasMore": true
}
```

### Export the whole record (NDJSON)

```http
GET /api/admin/audit-log/export
Authorization: Bearer <admin-token>
X-TOTP-Code: <code>   # required when MFA is enabled
```

The **same filters** as the query above, streamed as [NDJSON](https://ndjson.org) — one entry per line — with **no
row cap**. `limit` and `offset` are ignored. Entries come out **oldest first**, so the file reads like a log and
appending a later export to an earlier one stays in order; the paged endpoint is newest-first, because a screen wants
the recent thing at the top.

This is what answers "produce everything you hold about this subject's activity" in one request rather than a paging
script:

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" -H "X-TOTP-Code: $CODE" \
  "https://ythril.example.com/api/admin/audit-log/export?oidcSubject=user@example.com" \
  -o subject-activity.ndjson

# One JSON object per line, so it can be processed a line at a time however large it is.
wc -l subject-activity.ndjson
```

**Requires the second factor**, not merely an admin token. Paging through the log on screen and taking a copy of the
entire who-did-what record are different acts, and the second is what someone covering their tracks does first — so it
sits behind the same gate as a database backup.

**And it is itself audited**, as `audit.export`. Every other read of this log is exempt, so that reading it does not
write to it on every page of every scroll. The export is the deliberate exception: otherwise the most sensitive read
of the audit log would be the one read it never recorded. It is logged **regardless of** `audit.logReads`.

**A failure mid-stream destroys the connection** instead of ending the response cleanly. The status and the first
bytes are already sent by then, so a graceful end would hand you a well-formed file silently missing entries — for an
audit record the worst possible failure, because it looks complete. Treat a truncated transfer as a failed export and
retry; `curl -f` plus a line count is enough to notice.

### Audit entry fields

| Field | Type | Description |
|-------|------|-------------|
| `_id` | `string` | UUID v4 — unique entry identifier |
| `timestamp` | `string` | ISO-8601 timestamp |
| `tokenId` | `string \| null` | Token ID (null for auth failures) |
| `tokenLabel` | `string \| null` | Human-readable token label |
| `authMethod` | `"pat" \| "oidc" \| null` | Authentication method used |
| `oidcSubject` | `string \| null` | OIDC subject claim when auth method is OIDC |
| `ip` | `string` | Client IP address |
| `method` | `string` | HTTP method (GET, POST, PUT, PATCH, DELETE) |
| `path` | `string` | Request path |
| `spaceId` | `string \| null` | Target space (null for non-space operations) |
| `operation` | `string` | Structured event name (see tracked operations) |
| `status` | `number` | HTTP status code of the response |
| `entryId` | `string \| null` | Entry ID when the operation targets a specific document |
| `durationMs` | `number` | Request duration in milliseconds |
| `changes` | `AuditChange[]` | What actually changed — see below. Present only on a successful mutating request that has a recording rule; absent otherwise |

### What `changes` records, and what it deliberately does not

`changes` answers the question the rest of the entry cannot: *"an admin patched the space at 14:02"* does
not say whether they renamed it or turned strict linkage off.

Each element is one of two shapes:

```jsonc
{ "field": "validationMode", "from": "warn", "to": "strict" }   // scalar
{ "field": "tags", "added": ["auth"], "removed": ["draft"] }    // set
```

**It is an allowlist, never a redaction denylist.** Several audited routes handle secrets directly —
token create/regenerate, webhook create/update (target URLs and signing secrets), the media-config
routes (vision / STT / NLI / assist API keys) — and audit entries are queryable by any admin and retained
for `retentionDays`. Diffing a whole body and stripping known-secret names fails in the worst direction:
forget one field and a live key sits in a queryable store until retention expires, with nothing to report
it. Naming the fields that *may* be recorded fails the other way — forget one and the entry simply lacks
it, which is visible and harmless. **An operation with no rule records nothing.** Token, webhook and
provider-config routes are deliberately absent, and a record's free-form `properties` bag is excluded
from every rule because its keys are user-chosen and could hold a pasted credential.

Recorded values are **scalars or primitive lists only**. An allowlisted object would silently ship every
child it later gained.

**Schema changes are summarised, as names.** `space.schema.update` and `schema_library.update` change
nested objects, so the scalars-only rule dropped them entirely and no amount of adding field names could
have recorded them. They are recorded as name-set deltas instead:

```jsonc
{ "field": "typeSchemas.entity", "added": ["adr"], "removed": ["runbook"] }
{ "field": "typeSchemas.entity.service.propertySchemas", "added": ["sla"], "removed": ["tier"] }
```

Type names and property **keys** only — never a property's schema, default, enum or naming pattern, any
of which can be example data lifted from real records. A type that was added or removed outright is not
also itemised property-by-property, and the key list is capped at 25 per field. A schema replacement that
recorded nothing was the gap this closes: the schema decides what the space accepts from then on.

### Data retention

Entries expire automatically after `retentionDays` (default 90). MongoDB's TTL daemon handles the purge — no manual cleanup required.

### Admin UI

**Settings → Logs** provides a searchable, filterable view of the audit trail with:

- Date range, operation, space, status, and IP filters
- Paginated table with colour-coded status badges
- Click-to-detail modal for full entry JSON
- JSON and CSV export

---
