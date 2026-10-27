# Personal Views

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Personal views

A **personal view** is a named list of spaces that one token reads through as a single id. Its id is `@` and its
name (`@team`); you pass it where a read door takes a `space`, and the door reads each of the view's members the
caller can read at that moment and merges the answer.

### What you can rely on

- **A view is never a space.** It has no records, no files, no index and no network. No network, sync, export or
  token-rights row can name it, and a space id is still `^[a-z0-9-]+$`.
- **A view reads and never writes.** Every write door and every configuration door answers a view id as a missing
  space. To write, name one of the view's members.
- **A view never reads more than its caller could read by naming the member.** The members are judged per call, in
  the area of the door being called (`knowledge` for a recall, `files` for a file read), with the caller's rights as
  they are now. A member the caller cannot read drops out of that call; it does not refuse the call.
- **A view belongs to exactly one token.** Another token's view answers exactly as an id that never existed.
- **A narrowed answer says so.** Every answer through a view carries `viewMembers`: the spaces that call read. A
  caller that reads none of the members gets an empty answer with `viewMembers: []`, not a refusal.

The owner is the identity behind the token: `token:<id>` for an ordinary token, `oauth:<clientId>` for an MCP
connector, and `oidc:<issuer>#<sub>` for an OIDC session. Two tokens of one connector, or two sessions of one OIDC
subject, are one owner and see the same views; an OIDC session whose token carries no `sub` has no owner and cannot own
a view.

## The doors

REST and MCP take the same parameters and answer the same sentences.

| Capability | REST | MCP tool |
|---|---|---|
| List your views | `GET /api/views` → `{ views }` | `view_list` |
| Read one | `GET /api/views/:id` → `{ view }` | `view_get` (`view`) |
| Create | `POST /api/views` `{ name, members }` → `201 { view }` | `view_create` |
| Rename or change members | `PATCH /api/views/:id` `{ name?, members? }` → `{ view }` | `view_update` (`view`, `name?`, `members?`) |
| Delete | `DELETE /api/views/:id` → `204` | `view_delete` (`view`) |
| Give a token a copy | `POST /api/views/:id/copy` `{ toTokenId, fromTokenId? }` | `view_copy` |
| Instance admin: count orphaned views | `GET /api/admin/views/orphans` | `view_orphans` |
| Instance admin: take an unclaimed view | `POST /api/admin/views/claim` `{ name }` | `view_claim` |
| Instance admin: release a retired space id | `POST /api/admin/views/retired/:id/purge` `{ confirmOidcClaims? }` | `view_purge_retired` |
| Instance admin: what the 6.0 upgrade did | `GET /api/admin/views/migration` | `view_migration` |

A view as the doors answer it:

```json
{ "id": "@team", "name": "team", "members": ["qa", "research"], "readable": ["qa"], "createdAt": "2026-10-21T09:00:00.000Z" }
```

`members` is what the view lists (`["*"]` means every space); `readable` is the subset the caller reads in the
`knowledge` area now. A view the upgrade made carries `migratedFrom`. The owner key is never in an answer.

**Any token may use the owner doors, a read-only token included**: a view is a lens over what the token already reads,
and it writes nowhere. They need no space right, and the MCP tools are not `mutating` for read-only visibility
([MCP](16-mcp.md)). **A token bound to a
peer instance cannot create a view** (`403`, `view_peer_bound`).

**A view id in a URL is percent-encoded**, `%40team` for `@team`: `GET /api/views/%40team`. In a JSON body and in an
MCP argument it is written `@team`.

`POST /api/views` takes `name` (1 to 40 characters of `a-z`, `0-9` and `-`, unique among the owner's views) and
`members`: a list of space ids, or exactly `["*"]`. A listed member must exist and be readable by the caller when the
view is made or changed: a `read` rung in an area a view is read in, so a space the token holds only a schema rung on is
refused (`view_member_unknown`), as it would be read by no door. A member may not be a view. Duplicates in the list are collapsed. `PATCH` sends only what
changes, and an empty body is `400` (`view_nothing_to_change`).

## Reading through a view

**Which doors take a view.** A door takes a view in place of a space when it reads data and its area is not the
schema: `recall`, `similar`, `filter` (`POST /api/filter`), graph reads (`graph_traverse`, `traverse`), `space_stats` and the
stats routes, the embed-job and ingest status reads, the forks list (`GET /api/brain/spaces/:id/forks`, `list_forks`), file reads and listings (`read_file`, `list_dir`), the
`delete_entity_preview` read, and the live-event stream of a view (`GET /api/brain/spaces/:id/events`). Their `space`
parameter (REST: the path segment or the body field) accepts the owner's `@view`. A write, admin or schema door never
does.

**Merging.** A read through a view is computed over the merged set of the members it read, so `skip` means what it
means on a single space. `skip + limit` over more than one member is bounded on `filter` at 1 000, and exceeding it is
a `400` naming the ceiling; page a member directly for a deeper sweep. A recall through a view is fused once over the
merged pool ([Recall](04a-recall-api.md)). `maxChars` and the other budgets are unchanged.

**A live-event stream on a view ends** when the view stops reading what it read when the stream opened: the token is
revoked or expired, the view is deleted or its members change, or the token's rights narrow. Reconnect and the stream
reads the new set.

## Over MCP

The ten `view_*` tools are the twins of the doors above, with the same parameters and the same refusals. Who sees them:
`view_list`, `view_get`, `view_create`, `view_update`, `view_delete` and `view_copy` are **owner-scoped**, not
`mutating` for read-only visibility, so a token with a rights matrix sees and may call them even when it is read-only
(`view_copy` still needs the right to manage the receiving token). `view_claim`, `view_orphans`, `view_purge_retired` and
`view_migration` are admin tools, hidden from a token that is not an instance admin.

- **The `space` enum lists your views.** The `inputSchema` of exactly the read tools that take a view (`recall`,
  `similar`, `filter`, `graph_traverse`, `space_stats`, `list_embed_jobs`, `ingest_status`, `list_forks`, `read_file`, `list_dir`,
  `delete_entity_preview`) offers your views beside the spaces; the write enum does not. `tools/list` advertises
  `listChanged`, and `view_create`, `view_update` and `view_delete` send `notifications/tools/list_changed`, so a
  client that honours it refetches the schemas.
- **`viewMembers`** is in `structuredContent`, or a closing `viewMembers:` line on a text-only answer.
- **One-space auto-fill counts spaces only.** A token that reaches exactly one space may omit `space`; owning a view
  over that space does not change that.
- **`view_copy` answers `403` `view_copy_needs_mfa`** ("needs MFA step-up; use the web UI") in every case where REST
  would ask for MFA, because this door has no place to send a code.
- **An id the tool does not take answers as a missing space**: `Error: Space '@team' not found`, with the owner told it
  is a view. Another token's view and an unknown id answer the same words, and a retired id answers `410` with code
  `space_retired`.

## What a view refuses

Every door that does not take a view answers it as a missing space, before any body is read:

```json
{ "error": "Space '@team' not found. '@team' is a view; write to one of its member spaces" }
```

with status `404`. The second sentence is sent **to the owner only**; another token's view, and an id that never
existed, answer `Space '@team' not found` and nothing else, so the answer tells a caller nothing about who owns what.
That covers every write (`POST`, `PATCH`, `DELETE` of a record), every configuration read, `PATCH /api/spaces/:id`,
`reindex` and `reembed` (a missing space on both doors, before any work), and `graph_merge` and entity merge.
The pre-6.0 write-routing parameter is refused by name in 6.0 and answers `space` as its replacement ([Upgrading](02b-upgrading.md)).

## Limits

| Bound | Value |
|---|---|
| views one owner holds | 50 (`409`, `view_limit_reached`); a copy counts against the receiver |
| members of one view | 1 000, and `["*"]` counts one (`400`, `view_members_limit`) |
| name | 1 to 40 characters of `a-z`, `0-9`, `-` |

## Copying a view to another token

`POST /api/views/:id/copy` (MCP `view_copy`) gives a token you manage a **copy** that the receiver owns; the two views
are independent afterwards. It is the one view door that needs the second factor of managing a token: where the
instance asks for MFA on token management, REST asks for the step-up, and the MCP tool answers `403`
`view_copy_needs_mfa` ("needs MFA step-up; use the web UI") in exactly those cases. A caller who may manage the
receiver may copy a view of its own, or of a token it manages, naming the owner with `fromTokenId` when two managed
tokens hold a view of that name.

- The copy keeps **only the members the receiver reads**; a copy that would read nothing is `400`
  `view_copy_nothing_readable`. A `["*"]` view is judged by the spaces it stands for: a receiver that reads none of
  them gets the same refusal.
- **It is idempotent by receiver and source view**, and renaming the source does not change which view it is.
  Repeating it refreshes the earlier copy's members and answers `200`; the first copy answers `201`. Both doors
  answer `{ view, created }`, `created` saying which of the two happened.
- A name the receiver already holds becomes `<name>-2` (then `-3`, and so on).
- A receiver that is not a token you may manage, or does not exist, is one answer: `403` `view_copy_forbidden`; so
  is a caller who may manage no token at all, on both doors, before any second factor is asked.

## Lifecycle

- **Revoking a token deletes its owner's views at once.**
- **An MCP connector rotating its token keeps them**; the connector's client id is the owner.
- **A token evicted by the connector cap does not delete its views.** A sweep ends the views of an owner that has had no
  live token for 30 days. An OIDC owner's views are never swept.
- **A space deleted from the instance drops out of every view's members**, and a rename rewrites them. A view whose
  members all went is empty and reads nothing; it is not deleted.
- **Views live in `config.json`, not in the database**, so a Mongo backup does not carry them.

## Admin doors and migrated views

An instance admin's doors exist for the 6.0 upgrade ([Upgrading](02b-upgrading.md)):

- `GET /api/admin/views/orphans` answers `{ orphans: [{ ownerKind, count }], unclaimed: [{ name, members }] }`:
  how many views belong to an owner that holds no token, per kind (`token`, `oauth`), naming neither a view nor an
  owner, and the migrated definitions no admin token could own.
- `POST /api/admin/views/claim { name }` gives the calling admin a view with an unclaimed definition's members
  (`201`); an unknown name is `404` `view_claim_unknown`.
- `POST /api/admin/views/retired/:id/purge` drops everything a retired space id still holds (collections, vector
  indexes, files, activity) and releases the id: `{ released }`. Run it again if it answers a failure; the id stays
  reserved until it completes. While OIDC maps spaces from a claim it answers `409`
  `retired_purge_unconfirmed` and names `confirmOidcClaims`, because a user whose claim still names the id would reach a
  space created under it later; send `confirmOidcClaims: true` to purge anyway. An id that is not retired is `404`
  `retired_id_unknown`.
- `GET /api/admin/views/migration` answers `{ migrated, networksLostIds, unclaimed, retiredSpaceIds }`: the ids the
  upgrade converted, the networks that lost one (`networkId`, `label`, `spaceIds`), the definitions still waiting
  and the ids still reserved.

**A retired id answers `410 Gone`, code `space_retired`, on every door**, with a sentence telling the caller to ask the
instance admin. Creating a space under it, renaming a space to it and joining a network space under it are `409`
until it is purged. `GET /api/spaces` lists `retiredSpaceIds` to instance admins only.

## Refusals

| Code | Status | When |
|---|---|---|
| `view_not_found` | `404` | no view of yours has that id (also another token's view) |
| `view_name_taken` | `409` | you already hold a view of that name |
| `view_name_invalid` | `400` | not 1 to 40 characters of `a-z`, `0-9`, `-` |
| `view_limit_reached` | `409` | 50 views held |
| `view_members_limit` | `400` | more than 1 000 members |
| `view_members_empty` | `400` | `members` missing, empty or not a list of ids |
| `view_member_unknown` | `404` | a member does not exist, or you cannot read it |
| `view_member_is_view` | `400` | a member is itself a view |
| `view_owner_unknown` | `403` | an OIDC session with no `sub` cannot own a view |
| `view_peer_bound` | `403` | a peer-bound token creating or receiving a view |
| `view_nothing_to_change` | `400` | `PATCH` with neither `name` nor `members` |
| `view_copy_forbidden` | `403` | the receiver is not a token you may manage |
| `view_copy_nothing_readable` | `400` | the receiver reads none of the members |
| `view_copy_needs_mfa` | `403` | MCP `view_copy` where REST would ask for MFA |
| `view_claim_unknown` | `404` | no unclaimed definition of that name |
| `retired_id_unknown` | `404` | the id is not a retired space id |
| `retired_purge_unconfirmed` | `409` | OIDC maps spaces from a claim; send `confirmOidcClaims` |
| `space_retired` | `410` | any door naming a retired id |

A refusal answers `{ "error": "<sentence>", "code": "<code>" }`, plus `members` where the sentence names some or `limit`
where a cap refused. Branch on `code`.

## Audit and metrics

- **A read through a view is one audit row** with `spaceId: null` and `spaces: [<members read>]`; the recorded path
  carries `@view` in place of the view's id. Whether reads are logged at all is the existing `logReads` setting.
  The per-space activity counts one call in each member read, never one under the view.
- **A view act is a row of its own**: `view.create`, `view.update`, `view.delete`, `view.copy`, `view.claim` and
  `space.retired_id.purge`, carrying the owner key and the member count in `view` and never the name or the members.
  See the [Audit Log API](13-audit-log-api.md).
- **Metrics:** `ythril_views_total`, `ythril_views_deleted_total{reason}` (`revoke`, `sweep`, `owner`, `admin`) and
  `ythril_retired_space_ids` ([Setup API](11-setup-api.md)).
