# Space Deletion and Wipe

> Part of the [Ythril Integration Guide](../integration-guide.md).

Deleting a space and emptying one are the two acts that remove data. A space in a network is changed by a governance vote, so their answers depend on the vote as well as on this instance. The wipe of a space's collections is answered in [Brain API](04-brain-api.md) (`delete_space_data`) and [below](#the-admin-wipe-route) (the admin wipe route); the rules below are the same for both.

## Delete a Space

```http
DELETE /api/spaces/:id
Content-Type: application/json

{ "confirm": true }
```

`confirm: true` is required on every space, networked or not; without it the answer is `400` and nothing is deleted or opened. A built-in space answers `400` and is never deleted.

A space in a network is deleted by a governance vote in each network that holds it, and only this instance's copy is deleted. Every other member keeps its copy as a local space and the space leaves the network there. On a pub/sub network a subscriber's deletion is its own: no vote is opened and the publisher is not told; a publisher's deletion acts at once.

| Answer | Meaning |
|---|---|
| `204` (no body) | No network votes on the space (it is in none, or only in pub/sub networks this instance subscribes to). The local copy is deleted at once. |
| `200` `{ "status": "deleted", "rounds", "removedHere": true }` | This instance's own yes passed the round (a club or pub/sub network, or the only member) and the local copy is gone. |
| `202` `{ "status": "vote_pending", "rounds" }` | No round has passed yet. The space is deleted here when one does. |
| `202` `{ "status": "passed", "rounds", "queued": true }` | The vote passed and this instance's change is still running, past the answer budget. It completes on its own; check `GET /api/networks/:id` (`owedSpaceActs`), or the space's `actPending`. |
| `202` `{ "status": "passed", "rounds", "queued": true, "retryAt" }` | The vote passed and the change failed here; it is owed and retried at `retryAt`. The door does not restart it, so a repeat of the call only reads this answer. |
| `500` `{ "error", "code": "space_act_failed", "status": "passed", "rounds" }` | The vote passed and this instance's own change failed during this call. **Do not retry**: the vote passed and the instance retries the change itself. |
| `503` `{ "status": "passed", "rounds", "error" }`, with `Retry-After` | The same as the `500`, when the cause is a store outage. Do not retry. |
| `202` `{ "queued": true }`, or `{ "queued": true, "retryAt" }` | **No network votes on the space** (the `204` case), and this instance's change is still running past the answer budget, or failed and is owed and retried at `retryAt`. There is no `status` and no `rounds`: nothing was voted on, so nothing "passed". It completes on its own; the space's `actPending` on `GET /api/spaces` shows it. |
| `500` `{ "error", "code": "space_act_failed" }` | **No network votes on the space**, and the change failed during this call. The error says the change did not complete and is retried automatically. There is no `status` and no `rounds`. Do not retry; see the space's `actPending`. |
| `503` `{ "error", "retryable": true }`, with `Retry-After` | The same as that `500`, when the cause is a store outage. |
| `404` | After a completed delete: the space is already gone, which means done. |

Each round is `{ "networkId", "networkLabel", "roundId", "round" }`, where `round` is as the [vote list](08-networks-api.md#list-open-vote-rounds) shows it.

**Branch on `status`, not on the HTTP status alone.** A `200` means the deletion is done on this instance. A `202` with `status: "passed"` means the vote passed and the instance is finishing it, so do not repeat the call. A `500` or `503` with `status: "passed"` means the same, and the change is retried by the instance. An unnetworked deletion is not a vote and never answers `status: "passed"`: its `202` is `queued: true` and its failure is `code: "space_act_failed"`, with the same rule, do not repeat the call.

**Repeating the call** answers the vote while it is open, or the change while it is still being applied, with `repeated: true`. The rule is per network: in a network where the change has completed, the same call is a new request. A `404` after a delete means it is done.

The tool door, `POST /api/delete_space_data` and MCP `delete_space_data`, keep their envelope: `200` with `data.status` `"wiped"`, `"vote_pending"`, or `"passed"` with `data.queued`, and a failed change is `ok: false` with `data.status: "passed"` and `data.rounds`. A wipe no vote decided (the space is in no network, or this instance is only a subscriber of it) answers `data.queued: true` and, when it failed, `data.code: "space_act_failed"`, with no `data.status` and no `data.rounds`.

## The admin wipe route

Clear all data — or a specific subset of collection types — from a space, while
preserving the space itself (label, purpose, config, OIDC mappings, and quota
settings).

```http
POST /api/admin/spaces/:spaceId/wipe
Authorization: Bearer <admin-token>
X-TOTP-Code: <code>   # required when MFA is enabled
Content-Type: application/json
```

**Requires admin token** (and TOTP code when MFA is enabled).

> **`confirm: true` is required on every wipe.** Without it the answer is `400` and nothing is wiped or opened.
>
> **On a space that belongs to a network, the wipe is a vote.** Emptying a
> space the network shares is a governed act, like deleting one. A round opens in every network holding the
> space, this instance votes yes, and the wipe happens on **every member** when a round passes. A single veto
> stops it there.
>
> On a club or pub/sub network, or where this instance is the only member, its own yes passes the round and the wipe runs in the same request: the answer is `200` with `{ "status": "wiped", "rounds", "deleted" }`. Otherwise the answer is `202` with `{ "status": "vote_pending", "rounds": [...] }`, and the wipe happens on each member when its round passes. **Treat `vote_pending` as success** — do not retry, and do not read the missing counts as a failure. A vote that passed, whose change here is still running, answers `202` with `status: "passed"` and `queued: true`; it completes on its own. If the vote passed and this instance's change failed during the call, the answer is `500` with `code: "space_act_failed"` and `status: "passed"` (`503` for a store outage): do not retry, the instance retries the change itself. **A wipe no vote decides is not a vote** (a space in no network, or a pub/sub subscriber's own copy): if it outlasts the answer budget the answer is `202` with `{ "queued": true }` (and `retryAt` when it is owed), and if it failed during the call it is `500` with `code: "space_act_failed"` (`503` for a store outage), both with no `status` and no `rounds`; the change is retried automatically and the space's `actPending` on `GET /api/spaces` shows it. Each entry
> of `rounds` is `{ "networkId", "networkLabel", "roundId", "round" }`, `round` being the round as
> `GET /api/networks/:id/votes` shows it. Watch the rounds there.
>
> **A pub/sub subscriber wipes its own copy only**: it opens no round, the answer is `200` with `refills: true`, and the copy refills from its publisher at the next sync.
>
> **A space in no network is not voted on**: it wipes immediately and answers `200` with `{ "status": "wiped", "deleted" }`
> and no `rounds`.
>
> *Why it votes rather than propagating.* A wipe writes no tombstones and deletes the existing ones, and
> tombstones are the only thing that tells a peer a record is gone — so a local wipe on a shared space was
> undone by the next sync, which offered everything back to an instance that had no record of any deletion.
> Voting removes that problem rather than working around it: the peers are wiping too.
>
> The same rule governs the `delete_space_data` MCP tool, through the same planner.

### Request body

| Field | Type | Description |
|-------|------|-------------|
| `types` | `string[]` *(optional)* | Subset of collection types to wipe: `"facts"`, `"entities"`, `"edges"`, `"chrono"`, `"files"`, `"links"`. Omit to wipe **all** collections. |
| `confirm` | `boolean` *(required)* | Must be `true`. Without it the answer is `400` and nothing is wiped or opened. |

### Full wipe (all collections)

```json
{ "confirm": true }
```

or explicitly:

```json
{ "confirm": true, "types": ["facts", "entities", "edges", "chrono", "files", "links"] }
```

### Partial wipe (specific types only)

```json
{ "confirm": true, "types": ["facts"] }
```

```json
{ "types": ["entities", "edges"] }
```

### Response `200`

```json
{
  "deleted": {
    "facts": 12,
    "entities": 8,
    "edges": 5,
    "chrono": 0,
    "files": 3,
    "links": 17
  }
}
```

Each field in `deleted` is the number of documents actually removed from that
collection.  On a partial wipe the unaffected fields will be `0`.

`"links"` is usually the largest number and it is not a separate thing to clean up. A link record is one
mention of one record by another, so a space with a few hundred facts that name entities holds a link per
mention. Wiping `"facts"` alone leaves those links behind pointing at records that are gone — include
`"links"`, or omit `types` entirely and wipe everything.

### Behaviour notes

- **Idempotent** — wiping an already-empty space (or a type with no documents) returns `0` for that field; no error is raised.
- **Tombstones** — internal sync-tombstone records are cleared for the wiped types so peers do not re-sync deleted data. For full wipes all tombstones are cleared.  For partial wipes only the matching type tombstones are removed.
- **Files** — when `"files"` is included, both the MongoDB metadata collection and the physical files directory on disk are cleared. The directory is recreated empty so new uploads work immediately.
- **Space preserved** — the space itself is not deleted. Its label, purpose, configuration, OIDC mappings, and quota settings remain unchanged.

### Error responses

| Status | Meaning |
|--------|---------|
| `400` | `types` array contains an unrecognised collection type |
| `401` | Missing or invalid Authorization header |
| `403` | Token is not admin-scoped (or MFA code wrong/missing) |
| `404` | Space not found |

### Admin UI

In **Settings → Spaces**, every space row has a ⊘ **Wipe space** button.  Clicking it opens a confirmation dialog that shows the current per-collection document counts before proceeding.

### MCP tool

```text
delete_space_data(space: string, confirm: true, types?: string[])
```

Available in MCP-connected clients, and answered by the same planner as the admin route above. It needs space admin on the space named in `space`, not the instance admin rung. When `types` is omitted all collections are wiped. On a networked space it answers the vote, the same as the route; the answer carries `status` (`wiped`, `vote_pending` or `passed`), `rounds` and, where the wipe ran here, the counts. A wipe no vote decides answers `queued: true` with no `status` when it outlasts the answer budget. The full contract is in [Space Deletion and Wipe](06c-space-deletion-and-wipe-api.md) and [Brain API](04-brain-api.md).

## Every kind of act

A deletion, a wipe and a rename are acts of one space. A **restore** from a backup and a **migrate** to another database are
acts of the whole instance: one act on every space it serves, registered together, answered `202` by their own doors and
reported at [`GET /api/admin/data/restore`](12-admin-api.md#get-apiadmindatarestore) and
[`GET /api/admin/data/migrate`](12-admin-api.md#get-apiadmindatamigrate), never through a vote. While any act stands for a space,
the space takes no writes (`409` with the kind's own code: `space_being_deleted`, `space_being_wiped`, `space_being_renamed`,
`space_being_restored`, `space_being_migrated`) and its peer exchanges are held; the space's `actPending` names it.

| `kind` | What it acts on | Write refusal |
|---|---|---|
| `delete` | One space | `space_being_deleted` |
| `wipe` | Some or all of one space's collections | `space_being_wiped` (only the wiped types) |
| `rename` | One space | `space_being_renamed` |
| `restore` | Every space, made equal to a backup | `space_being_restored` |
| `migrate` | Every space, copied to another database | `space_being_migrated` |

**A client treats a kind, or a `space_being_*` code, it does not know as "this space is busy"**: a newer server adds kinds,
and an older client must still show the space as closed rather than fail on the word.

**A rename during a restore or migrate is refused at once**, on `PATCH /api/spaces/:id/rename` and on MCP `space_rename` alike: `409`
with the standing act's own write-refusal code (`space_being_restored` or `space_being_migrated`), the sentence the space's writes are
refused with, and nothing registered. It is never queued behind the act with its request held open for the act's length; send it again
once the act has completed. A rename meeting a deletion or wipe of its space is refused too (`409`, no code).
