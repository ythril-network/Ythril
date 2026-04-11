# Ythril

**Self-hosted brain server for AI assistants.** Persistent memory, knowledge graphs, semantic search, file storage, and multi-brain sync — all behind a standard MCP interface, fully under your control.

Ythril gives every MCP-compatible client (Claude, Cursor, Windsurf, VS Code Copilot, or anything that speaks the [Model Context Protocol](https://modelcontextprotocol.io)) a persistent, structured knowledge backend. Data is organised into **spaces** — isolated containers with their own memories, entities, edges, timelines, files, and schemas. Each space exposes its own MCP endpoint with 29 tools, a full REST API, and a web UI. Spaces can be synced across multiple brains through policy-driven networks with fine-grained governance. Run it with `docker compose up -d` and you are ready in under a minute.

---

## Key Capabilities

### Semantic Recall

Store facts and context as **memories** with automatic vector embeddings. The `recall` and `recall_global` MCP tools perform semantic search across all knowledge types — memories, entities, edges, chrono entries, and files — using MongoDB Atlas `$vectorSearch`. Results are ranked by similarity and include a type discriminator, so an LLM can search the entire brain with a single natural-language query.

### Knowledge Graph

Model structured knowledge with **entities** (named, typed, with properties), **edges** (directed, labelled, weighted relationships), and **graph traversal** (multi-hop BFS with direction control and cycle detection). The `traverse` tool lets an LLM explore connections from any entity up to N hops deep, and the `query` tool supports arbitrary MongoDB filter queries on any collection.

### Chrono Timeline

Track events, deadlines, plans, predictions, and milestones with the **chrono** subsystem. Date-range filters, AND/OR tag queries, full-text search, kind/status filtering, and pagination come built in.

### File Storage

Full file manager with **chunked upload** (5 MB pieces, progress tracking, automatic retry), directory tree, inline preview (text, code, images, PDF), and file-level metadata (description, tags, properties). All file operations are available as MCP tools and via the REST API.

### Schema Validation

Define allowed entity types, edge labels, naming patterns (regex), required properties, and property value schemas per space. Enforce them in **strict** mode (reject violations), **warn** mode (accept with warnings), or leave validation **off**. Schemas are evaluated on individual writes, bulk operations, and a dry-run `validate-schema` endpoint lets you audit existing data against a schema change before committing it.

### Bulk Operations

The `bulk_write` tool and `POST /api/brain/spaces/:spaceId/bulk` endpoint batch-upsert up to 500 memories, entities, edges, and chrono entries in a single call. Processing order is deterministic (memories → entities → edges → chrono), so edges can reference entities created in the same batch. Schema validation is applied per item.

### Proxy Spaces

A **proxy space** groups multiple real spaces into a single virtual endpoint. Read operations (recall, query, list) aggregate results across all member spaces transparently. Write operations route to a specific member via `targetSpace`. Proxy spaces have no storage of their own — they are pure aggregation layers.

### Space Export & Import

`GET /api/admin/spaces/:spaceId/export` dumps the entire knowledge base of a space (memories, entities, edges, chrono, file metadata) as a single JSON document. `POST /api/admin/spaces/:spaceId/import` upserts it back — useful for backup, migration, or seeding new brains.

### Find Similar

Given an existing entry's `_id`, find other entries with high vector similarity — no re-embedding step. The `find_similar` MCP tool and `POST /api/brain/spaces/:spaceId/find-similar` REST endpoint use the entry's **stored embedding vector** directly. Supports cross-space search, target-type filtering, score thresholds, and configurable result count. Ideal for deduplication, "more like this", and merge detection.

### Audit Log

Append-only, immutable access log of every authenticated API operation. The audit trail captures token identity, OIDC subject, operation name, target space, HTTP status, client IP, and request duration. Entries are automatically purged after a configurable retention period (default 90 days). The web UI (**Settings → Audit Log**) provides filterable search, detail views, and JSON/CSV export. Configure `logReads` to include or exclude read operations.

### Webhooks

Subscribe external systems to real-time HTTP POST notifications when write events occur. Supports 15 event types across memories, entities, edges, chrono, and files. Payloads are signed with HMAC-SHA256, delivered with at-least-once guarantees (6 retries with exponential backoff), and SSRF-protected to block private/reserved IP targets. Manage subscriptions through the REST API or the **Settings → Webhooks** UI.

### 29 MCP Tools

Every capability is exposed as an MCP tool that any LLM client can call:

| Category | Tools |
|----------|-------|
| Memory | `remember`, `recall`, `recall_global`, `update_memory`, `delete_memory`, `find_similar` |
| Knowledge graph | `upsert_entity`, `update_entity`, `find_entities_by_name`, `upsert_edge`, `update_edge`, `traverse`, `query` |
| Timeline | `create_chrono`, `update_chrono`, `list_chrono` |
| Files | `read_file`, `write_file`, `list_dir`, `delete_file`, `create_dir`, `move_file` |
| Batch & admin | `bulk_write`, `get_stats`, `get_space_meta`, `update_space`, `wipe_space` |
| Sync | `list_peers`, `sync_now` |

Read-only tokens automatically hide all mutating tools and block them if called directly.

### Multi-Brain Sync

Brains can form **networks** to sync selected spaces. Five network types define governance and data flow:

| Type | Topology | Governance |
|------|----------|------------|
| **Closed** | Full mesh, bidirectional | Unanimous vote to add/remove members |
| **Democratic** | Full mesh, bidirectional | Majority vote |
| **Club** | Full mesh, bidirectional | Inviter approves unilaterally |
| **Braintree** | Hierarchical push-only (root → leaves) | Ancestor approves |
| **Pub/Sub** | One publisher → many subscribers | Auto-accept, push-only |

Sync uses watermark-based incremental replication with SHA-256 file manifests, Merkle verification, and conflict detection with four resolution strategies (keep-local, keep-incoming, keep-both, save-to-space).

### Security & Auth

- **PAT tokens** (`ythril_*`) with bcrypt-hashed storage, per-space scope, read-only mode, and expiry dates
- **OIDC / SSO** — Authorization Code + PKCE with Keycloak, Entra ID, Okta, Auth0, or any OIDC-compliant IdP
- **Optional TOTP MFA** for admin mutations
- **RSA-4096-OAEP zero-knowledge invite handshake** for network joining
- **MongoDB operator whitelist** — blocks `$where`, `$function`, injection via `$options`
- **ReDoS protection** on all user-supplied regex patterns
- **Path sandboxing** against traversal, null bytes, and encoded characters
- **SSRF guards** blocking RFC-1918, loopback, IMDS, IPv6 ULA, link-local, and embedded credentials
- **Storage quotas** (soft/hard limits) for files and brain data
- **Global rate limiting** (configurable per-endpoint)
- **Content-Security-Policy**, security headers, `0600` config file enforcement

---

## Getting Started

```bash
docker compose up -d
# → open http://localhost:3200
```

| Doc | Description |
|-----|-------------|
| [User Guide](docs/userguide.md) | Web UI walkthrough — brain, files, settings, connecting MCP clients |
| [Integration Guide](docs/integration-guide.md) | Hosting, configuration, full REST API and MCP tool reference |
| [Use Case Examples](docs/usecase-examples.md) | 26 practical deployment scenarios |

For development setup, testing, and building from source see the [Contribution Guide](docs/contribution-guide.md).

### Connecting an MCP Client

Point any MCP-compatible client at your brain:

```json
{
  "mcpServers": {
    "ythril": {
      "url": "http://localhost:3200/mcp/general",
      "headers": { "Authorization": "Bearer ythril_your_token_here" }
    }
  }
}
```

Each space has its own MCP endpoint (`/mcp/{spaceId}`). The AI assistant immediately sees the space's purpose, schema, and all available tools.

---

## Network Topologies

See [Network Types](docs/network-types.md) for the full specification.

**Standalone** — single brain, no sync, full local control.

```mermaid
flowchart LR
	subgraph BA["🧠 Brain"]
		SA[space]
	end
```

**Closed / Democratic / Club** — symmetric sync between all members.

```mermaid
flowchart LR
	subgraph BA["🧠 Brain A"]
		SA[space]
	end
	subgraph BB["🧠 Brain B"]
		SB[space]
	end
	subgraph BC["🧠 Brain C"]
		SC[space]
	end

	SA <--> SB
	SA <--> SC
	SB <--> SC
```

**Braintree** — push-only from a root brain down to subscribers.

```mermaid
flowchart TD
	subgraph BR["🧠 Root"]
		SR[space]
	end
	subgraph BA["🧠 Brain A"]
		SA[space]
	end
	subgraph BB["🧠 Brain B"]
		SB[space]
	end
	subgraph BC["🧠 Brain C"]
		SC[space]
	end
	subgraph BD["🧠 Brain D"]
		SD[space]
	end

	SR --> SA
	SR --> SB
	SA --> SC
	SA --> SD
```

**Pub/Sub** — single publisher distributes knowledge to any number of subscribers.

```mermaid
flowchart TD
	subgraph PUB["🧠 Publisher"]
		SP[space]
	end
	subgraph S1["🧠 Sub A"]
		SA[space]
	end
	subgraph S2["🧠 Sub B"]
		SB[space]
	end
	subgraph S3["🧠 Sub C"]
		SC[space]
	end

	SP --> SA
	SP --> SB
	SP --> SC
```

---

## License

Ythril is source-available under the [PolyForm Small Business License 1.0.0](LICENSE). Individuals and small businesses (< 100 people, < $1M revenue) can use, modify, and self-host it freely. Larger organisations require a commercial license — contact `contact@ythril.net`.

## Contributing

Contributions are welcome. Open an issue for bugs or proposals, keep changes scoped and testable, and submit a pull request with a short rationale. See the [Contribution Guide](docs/contribution-guide.md) for dev setup and testing instructions.
