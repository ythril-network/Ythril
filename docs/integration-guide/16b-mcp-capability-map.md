# MCP Capability Map

> Part of the [Ythril Integration Guide](../integration-guide.md). The tools themselves are on [MCP](16-mcp.md).

## MCP capability map: every tool, its REST route and the rung it needs

Every capability, the MCP tool and the REST route that perform it, and what a token needs to call it. The table is
generated from the code and written by `scripts/surface-matrix.mjs --write`; a gate holds it equal to what the
code renders, so it is the same list the server enforces and an edit made by hand inside the markers is overwritten.

**How to read the token column.** REST enforces a per-space **rung** (`read` / `write` / `admin`) for an area —
`knowledge`, `files`, `schema`, `dataQuality`. MCP gates on the token's flags, and a tool with its own rights row is
priced by that row: a read-only token cannot see mutating tools, and a non-admin token cannot see admin tools. Where
the two differ the cell names both doors in bold. `instance-level` means the route sits outside the per-space
matrix by design (`/api/spaces`, `/api/tokens`, `/api/networks`), and `REST exempt` means the REST route is not
area-scoped. A note after the dash is what a rung cannot say: the spaces it must hold on, or an extra grant.

**There is no "MCP only".** Every tool in this table is `POST /api/<tool-name>` as well; see
[The same tools over plain HTTP](16-mcp.md#the-same-tools-over-plain-http). The REST column names the OLDER route
where one exists, because that is the one whose shape differs; where there is none, the tool door is the only shape
and the two are identical by construction. The REST routes with no tool are in
[Never built](16-mcp.md#telling-absent-from-your-token-cannot-see-it).

<!-- generated: capability-map -->

| capability | MCP tool | REST route | token needs |
|---|---|---|---|
| **Brain — facts** | | | |
| | `save_fact` | `POST /api/save_fact` · legacy: `POST /api/brain/spaces/:spaceId/facts` | write `knowledge` |
| | `update_fact` | `POST /api/update_fact` · legacy: `PATCH /api/brain/spaces/:spaceId/facts/:id` | write `knowledge` |
| | `delete_fact` | `POST /api/delete_fact` · legacy: `DELETE /api/brain/spaces/:spaceId/facts/:id` | write `knowledge` |
| **Brain — entities** | | | |
| | `save_entity` | `POST /api/save_entity` · legacy: `POST /api/brain/spaces/:spaceId/entities` | write `knowledge` |
| | `update_entity` | `POST /api/update_entity` · legacy: `PATCH /api/brain/spaces/:spaceId/entities/:id` | write `knowledge` |
| | `delete_entity` | `POST /api/delete_entity` · legacy: `DELETE /api/brain/spaces/:spaceId/entities/:id` | write `knowledge` |
| | `delete_entity_preview` | `POST /api/delete_entity_preview` · legacy: `GET /api/brain/spaces/:spaceId/entities/:id/cascade-preview` | read `knowledge` |
| | `graph_merge` | `POST /api/graph_merge` · legacy: `POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId` | write `knowledge` |
| **Brain — edges** | | | |
| | `save_edge` | `POST /api/save_edge` · legacy: `POST /api/brain/spaces/:spaceId/edges` | write `knowledge` |
| | `update_edge` | `POST /api/update_edge` · legacy: `PATCH /api/brain/spaces/:spaceId/edges/:id` | write `knowledge` |
| | `delete_edge` | `POST /api/delete_edge` · legacy: `DELETE /api/brain/spaces/:spaceId/edges/:id` | write `knowledge` |
| **Brain — chrono** | | | |
| | `save_chrono` | `POST /api/save_chrono` · legacy: `POST /api/brain/spaces/:spaceId/chrono` | write `knowledge` |
| | `update_chrono` | `POST /api/update_chrono` · legacy: `PATCH /api/brain/spaces/:spaceId/chrono/:id` | write `knowledge` |
| | `delete_chrono` | `POST /api/delete_chrono` · legacy: `DELETE /api/brain/spaces/:spaceId/chrono/:id` | write `knowledge` |
| **Brain — links** | | | |
| | `save_link` | `POST /api/save_link` · legacy: `POST /api/brain/spaces/:spaceId/links` | write `knowledge` |
| | `delete_link` | `POST /api/delete_link` · legacy: `DELETE /api/brain/spaces/:spaceId/links/:id` | write `knowledge` |
| **Brain — search** | | | |
| | `recall` | `POST /api/recall` · legacy: `POST /api/brain/recall` | read `knowledge` |
| | `similar` | `POST /api/similar` · legacy: `POST /api/brain/similar` | read `knowledge` |
| | `read_spill` | `POST /api/read_spill` · legacy: `GET /api/brain/spills/:id` | read (MCP) · REST exempt — read `knowledge` on every space in the spill, by the token that ran the search |
| | `graph_traverse` | `POST /api/graph_traverse` · legacy: `POST /api/brain/spaces/:spaceId/traverse` | read `knowledge` |
| **Brain — bulk** | | | |
| | `save_bulk` | `POST /api/save_bulk` · legacy: `POST /api/brain/spaces/:spaceId/bulk` | write `knowledge` |
| **Brain — ingest** | | | |
| | `ingest` | `POST /api/ingest` · legacy: `POST /api/brain/spaces/:spaceId/ingest` | write `knowledge` |
| **Brain — ingest status** | | | |
| | `ingest_status` | `POST /api/ingest_status` · legacy: `GET /api/brain/spaces/:spaceId/ingest/:runId` | read `knowledge` |
| **Brain — ops** | | | |
| | `space_stats` | `POST /api/space_stats` · legacy: `GET /api/brain/spaces/:spaceId/stats` | read `knowledge` |
| | `space_reindex` | `POST /api/space_reindex` · legacy: `POST /api/brain/spaces/:spaceId/reindex` | admin `knowledge` |
| | `list_embed_jobs` | `POST /api/list_embed_jobs` · legacy: `GET /api/brain/spaces/:spaceId/embedding-queue/records` | read `knowledge` |
| | `retry_embed_record` | `POST /api/retry_embed_record` · legacy: `POST /api/brain/spaces/:spaceId/embedding-queue/records/retry` | write `knowledge` |
| | `list_forks` | `POST /api/list_forks` · legacy: `GET /api/brain/spaces/:spaceId/forks` | read `knowledge` |
| | `resolve_fork` | `POST /api/resolve_fork` · legacy: `POST /api/brain/spaces/:spaceId/forks/:forkId/resolve` | write `knowledge` |
| | `retry_embed_media` | `POST /api/retry_embed_media` · legacy: `POST /api/brain/spaces/:spaceId/embedding-queue/media/retry-failed` | write `files` |
| **Files** | | | |
| | `write_file` | `POST /api/write_file` · legacy: `POST /api/files/:spaceId` | write `files` |
| | `move_file` | `POST /api/move_file` · legacy: `PATCH /api/files/:spaceId` | write `files` |
| | `delete_file` | `POST /api/delete_file` · legacy: `DELETE /api/files/:spaceId` | write `files` — a directory too, with `confirm: true`, as on REST |
| | `create_dir` | `POST /api/create_dir` · legacy: `POST /api/files/:spaceId/mkdir` | write `files` |
| | `retry_embed_file` | `POST /api/retry_embed_file` · legacy: `POST /api/files/:spaceId/retry_embedding` | write `files` |
| | `read_file` | `POST /api/read_file` · legacy: `GET /api/brain/spaces/:spaceId/files/extract` | read `files` |
| | `update_file_meta` | `POST /api/update_file_meta` · legacy: `PATCH /api/brain/spaces/:spaceId/files` | write `files` |
| **Spaces** | | | |
| | `list_spaces` | `POST /api/list_spaces` · legacy: `GET /api/spaces` | read (MCP) · REST exempt |
| | `save_space` | `POST /api/save_space` · legacy: `POST /api/spaces` | write (MCP) · REST exempt — `createSpaces` (or instance admin) |
| | `update_space` | `POST /api/update_space` · legacy: `PATCH /api/spaces/:id` | write (MCP) · REST exempt — space-admin of the named space, and write `schema` |
| | `space_rename` | `POST /api/space_rename` · legacy: `PATCH /api/spaces/:id/rename` | space-admin (MCP) · REST exempt — space-admin of the named space |
| | `space_meta` | `POST /api/space_meta` · legacy: `GET /api/spaces/:id/meta` | read `schema` |
| | `schema_update` | `POST /api/schema_update` · legacy: `PUT /api/spaces/:id/schema` | admin `schema` |
| | `space_schema_layers` | `POST /api/space_schema_layers` · legacy: `GET /api/spaces/:id/schema-layers` | read `schema` |
| | `space_set_network_precedence` | `POST /api/space_set_network_precedence` · legacy: `PUT /api/spaces/:id/network-precedence` | admin `schema` |
| | `space_reembed` | `POST /api/space_reembed` · legacy: `POST /api/spaces/:id/reembed` | admin `knowledge` |
| | `file_stamp_report` | `POST /api/file_stamp_report` · legacy: `POST /api/spaces/:id/file-stamp-report` | instance-admin (MCP) · REST exempt |
| | `schema_validate` | `POST /api/schema_validate` · legacy: `POST /api/spaces/:id/validate-schema` | read `schema` |
| **Tokens** | | | |
| | `list_tokens` | `POST /api/list_tokens` · legacy: `GET /api/tokens` | instance-admin (MCP) · instance-level |
| | `list_tokens` | `POST /api/list_tokens` · legacy: `GET /api/brain/spaces/:spaceId/token-access` | instance-admin (MCP) · REST exempt |
| | `help` | `POST /api/help` · legacy: `GET /api/tokens/me` | read (MCP) · instance-level |
| **Networks** | | | |
| | `network_peers` | `POST /api/network_peers` · legacy: `GET /api/networks` | read `networks` — on every space of each network |
| | `network_get` | `POST /api/network_get` · legacy: `GET /api/networks/:id` | read `networks` — on every space it carries |
| | `network_create` | `POST /api/network_create` · legacy: `POST /api/networks` | write `networks` — on every space, or administering each |
| | `network_update` | `POST /api/network_update` · legacy: `PATCH /api/networks/:id` | admin `networks` — on every space it carries |
| | `network_leave` | `POST /api/network_leave` · legacy: `DELETE /api/networks/:id` | write `networks` — your own membership; admin for anyone's |
| | `network_add_space` | `POST /api/network_add_space` · legacy: `POST /api/networks/:id/spaces` | write `networks` — admin `networks` on every space it carries · write on the added one |
| | `network_pending_space` | `POST /api/network_pending_space` · legacy: `POST /api/networks/:id/pending-spaces` | write `networks` — accept: `networks: write` on an existing space, `createSpaces` for a new one · dismiss: `networks: admin` on every space the network carries |
| | `network_votes` | `POST /api/network_votes` · legacy: `GET /api/networks/:id/votes` | instance-admin (MCP) · REST exempt |
| | `network_vote` | `POST /api/network_vote` · legacy: `POST /api/networks/:id/votes/:roundId` | instance-admin (MCP) · REST exempt |
| | `network_vote_outcomes` | `POST /api/network_vote_outcomes` · legacy: `GET /api/networks/:id/vote-outcomes` | instance-admin (MCP) · REST exempt |
| | `network_sync_history` | `POST /api/network_sync_history` · legacy: `GET /api/networks/:id/sync-history` | instance-admin (MCP) · REST exempt |
| | `network_change_notes` | `POST /api/network_change_notes` · legacy: `GET /api/networks/:id/change-notes` | instance-admin (MCP) · REST exempt |
| | `network_reread` | `POST /api/network_reread` · legacy: `POST /api/networks/:id/reread` | instance-admin (MCP) · REST exempt |
| | `network_invite` | `POST /api/network_invite` · legacy: `POST /api/networks/:id/invite` | write (MCP) · REST exempt — instance admin · administers every space |
| | `network_fork` | `POST /api/network_fork` · legacy: `POST /api/networks/:id/fork` | instance-admin (MCP) · REST exempt |
| | `network_join_remote` | `POST /api/network_join_remote` · legacy: `POST /api/networks/join-remote` | write `networks` — `networks: write` on every space it maps to · `createSpaces` for a space it creates |
| | `network_join_by_key` | `POST /api/network_join_by_key` · legacy: `POST /api/networks/join-by-key` | write `networks` — `networks: write` on every space it maps to · `createSpaces` for a space it creates |
| | `network_member_add` | `POST /api/network_member_add` · legacy: `POST /api/networks/:id/members` | instance-admin (MCP) · REST exempt |
| | `network_member_remove` | `POST /api/network_member_remove` · legacy: `DELETE /api/networks/:id/members/:instanceId` | instance-admin (MCP) · REST exempt |
| | `network_introduction_accept` | `POST /api/network_introduction_accept` · legacy: `POST /api/networks/:id/introductions/:instanceId/accept` | instance-admin (MCP) · REST exempt |
| | `network_member_admit` | `POST /api/network_member_admit` · legacy: `POST /api/networks/:id/join` | instance-admin (MCP) · REST exempt |
| | `network_member_signing_key` | `POST /api/network_member_signing_key` · legacy: `PUT /api/networks/:id/members/:instanceId/signing-key` | instance-admin (MCP) · REST exempt |
| | `network_reparent_self` | `POST /api/network_reparent_self` · legacy: `POST /api/networks/:id/reparent-self` | instance-admin (MCP) · REST exempt |
| | `network_member_adopt` | `POST /api/network_member_adopt` · legacy: `POST /api/networks/:id/members/:instanceId/adopt` | instance-admin (MCP) · REST exempt |
| | `network_member_revert_parent` | `POST /api/network_member_revert_parent` · legacy: `POST /api/networks/:id/members/:instanceId/revert-parent` | instance-admin (MCP) · REST exempt |
| | `network_sync` | `POST /api/network_sync` · legacy: `POST /api/networks/:id/sync` | instance-admin (MCP) · REST exempt |
| | `network_sync` | `POST /api/network_sync` · legacy: `POST /api/networks/peers/:peerId/sync` | instance-admin (MCP) · REST exempt |
| **Personal views** | | | |
| | `view_list` | `POST /api/view_list` · legacy: `GET /api/views` | read (MCP) · REST exempt — owner-scoped: any token with a rights matrix |
| | `view_get` | `POST /api/view_get` · legacy: `GET /api/views/:id` | read (MCP) · REST exempt — owner-scoped: any token with a rights matrix |
| | `view_create` | `POST /api/view_create` · legacy: `POST /api/views` | read (MCP) · REST exempt — owner-scoped: any token with a rights matrix |
| | `view_update` | `POST /api/view_update` · legacy: `PATCH /api/views/:id` | read (MCP) · REST exempt — owner-scoped: any token with a rights matrix |
| | `view_delete` | `POST /api/view_delete` · legacy: `DELETE /api/views/:id` | read (MCP) · REST exempt — owner-scoped: any token with a rights matrix |
| | `view_copy` | `POST /api/view_copy` · legacy: `POST /api/views/:id/copy` | read (MCP) · REST exempt — owner-scoped, and may manage the receiving token (MFA step-up on REST) |
| **Tools — one shape only** | | | |
| | `delete_space_data` | `POST /api/delete_space_data` | space-admin · both doors — space-admin of the named space |
| | `filter` | `POST /api/filter` | read · both doors |
| | `list_dir` | `POST /api/list_dir` | read · both doors |
| | `view_claim` | `POST /api/view_claim` | instance-admin · both doors — REST: `/api/admin/views/claim` |
| | `view_migration` | `POST /api/view_migration` | instance-admin · both doors — REST: `/api/admin/views/migration` |
| | `view_orphans` | `POST /api/view_orphans` | instance-admin · both doors — REST: `/api/admin/views/orphans` |
| | `view_purge_retired` | `POST /api/view_purge_retired` | instance-admin · both doors — REST: `/api/admin/views/retired/:id/purge` |

<!-- /generated: capability-map -->
