# Space Deletion and Wipe

> Part of the [Ythril Integration Guide](../integration-guide.md).

Deleting a space and emptying one are the two acts that remove data. A space in a network is changed by a governance vote, so their answers depend on the vote as well as on this instance. The wipe of a space's collections is answered in [Brain API](04-brain-api.md) (`delete_space_data`) and [Admin API](12-admin-api.md) (the admin wipe route); the rules below are the same for both.

### Delete a Space

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
| `404` | After a completed delete: the space is already gone, which means done. |

Each round is `{ "networkId", "networkLabel", "roundId", "round" }`, where `round` is as the [vote list](08-networks-api.md#list-open-vote-rounds) shows it.

**Branch on `status`, not on the HTTP status alone.** A `200` means the deletion is done on this instance. A `202` with `status: "passed"` means the vote passed and the instance is finishing it, so do not repeat the call. A `500` or `503` with `status: "passed"` means the same, and the change is retried by the instance.

**Repeating the call** answers the vote while it is open, or the change while it is still being applied, with `repeated: true`. The rule is per network: in a network where the change has completed, the same call is a new request. A `404` after a delete means it is done.

The tool door, `POST /api/delete_space_data` and MCP `delete_space_data`, keep their envelope: `200` with `data.status` `"wiped"`, `"vote_pending"`, or `"passed"` with `data.queued`, and a failed change is `ok: false` with `data.status: "passed"` and `data.rounds`.
