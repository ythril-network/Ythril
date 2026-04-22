# Ythril User Guide

> How to use the Ythril web interface and connect MCP clients.

For hosting, deployment, and API reference see [integration-guide.md](integration-guide.md).
For fastest workstation deployment steps see [workstation-mode-guide.md](workstation-mode-guide.md).
For contributing and building from source see [contribution-guide.md](contribution-guide.md).

---

## Table of Contents

1. [Logging in](#logging-in)
2. [Brain — Memories](#brain--memories)
3. [Brain — Entities & Edges](#brain--entities--edges)
4. [Brain — Chrono](#brain--chrono)
5. [Brain — Query](#brain--query)
6. [Graph](#graph)
7. [Files](#files)
8. [File preview](#file-preview)
9. [Directory tree sidebar](#directory-tree-sidebar)
10. [Conflict resolution](#conflict-resolution)
11. [Settings — Spaces](#settings--spaces)
12. [Settings — Tokens](#settings--tokens)
13. [Settings — MFA](#settings--mfa)
14. [Settings — Networks](#settings--networks)
15. [Settings — Storage](#settings--storage)
16. [Settings — Audit Log](#settings--audit-log)
17. [Settings — Webhooks](#settings--webhooks)
18. [Settings — About](#settings--about)
19. [Connecting MCP clients](#connecting-mcp-clients)

---

## Logging in

Open `http://localhost:3200` (or your instance URL). Enter your admin PAT — the token you received during setup — and click **Log in**.

The token is stored in browser `localStorage` under `ythril_token`. Logging out clears it.

### SSO / OIDC login

When an administrator has configured an OIDC provider (see [OIDC Configuration](integration-guide.md#oidc-openid-connect-authentication)), the login page **auto-redirects** to your organisation's identity provider — no extra click required. After authenticating there you are redirected back and logged in automatically.

To bypass SSO and use a PAT instead, navigate to `/login?local`. This is useful for administrators, or when the identity provider is unavailable.

Both login methods coexist: PAT users are unaffected when OIDC is enabled.

### Navigation

The left sidebar has three main sections:

| Section | What it does |
|---------|--------------|
| **Brain** | Store and search memories, manage entities and knowledge-graph edges |
| **Graph** | Visually explore the knowledge graph — search an entity and browse N hops deep |
| **Files** | Browse, upload, download, move, and delete files |
| **Settings** | Tokens, spaces, networks, MFA, storage, about |

Everything is scoped to the spaces your token has access to. A token with `spaces: ["eng-kb"]` only sees that space throughout the UI.

A red **conflict badge** appears next to **Files** in the sidebar when unresolved file conflicts exist. The count updates every 60 seconds.

---

## Brain — Memories

The **Brain** tab shows all memories in the selected space, sorted newest-first.

### Space stats and reindex

Five stat pills at the top of the Brain view show current counts: **memories**, **entities**, **edges**, **chrono**, and **files**.

If the embedding model has changed since the last embed run, an **⚠️ Needs reindex** warning banner appears. Click **Reindex now** to rebuild all vector embeddings for the space. Progress is tracked server-side; a completion message appears when done.

### Creating a memory

Click **+ Add memory** in the toolbar. Fill in the form:

| Field | Required | Description |
|-------|----------|--------------|
| Fact | Yes | The statement to remember. |
| Tags | No | Comma-separated categorisation tags. |
| Entities | No | Click to open the entity picker flyout. Search by name and click an entity to link it. Linked entities appear as chips; click **✕** on a chip to unlink. |
| Description | No | Free-text context or rationale behind the fact. |
| Properties | No | Click to open the JSON editor flyout. Enter an arbitrary key-value object (e.g. `{"source": "docs", "confidence": 0.9}`). Live validation and a **Format** button are provided. |

Click **Save**. The memory is embedded and stored immediately. `description` and `properties` are also shown on each memory row in the list. The **Entities** column shows how many entities are linked.

Memories can also be written by MCP clients (e.g. Claude, Cursor) using the `remember` tool, or via the REST API (`POST /api/brain/:spaceId/memories`).

### Semantic search (Recall)

Type a natural-language query in the search bar and press Enter. Ythril uses the built-in embedding model and MongoDB vector search to find semantically similar memories. Results show a similarity score.

### Filtering

Click any **tag pill** or **entity badge** on a memory row to filter the list. Active filters appear as removable chips above the table. Click the **×** on a chip to clear it, or **Clear all** to reset.

### Deleting memories

Each memory row has a **✕** delete button. Clicking it shows an inline **Delete? / Yes / No** confirmation in the same row — no browser dialog. Click **Yes** to confirm or **No** (or any other ✕ button) to cancel.

### Bulk wipe

To delete all memories in a space, click **Wipe all** in the toolbar. A confirmation dialog will ask you to type the space ID to proceed. This writes tombstones so the deletion syncs to peers.

---

## Brain — Entities & Edges

### Entities

Entities are named concepts inside a space (e.g. "Kubernetes", "Team Alpha"). Each entity has a `name`, an optional `type` (e.g. `technology`, `person`), optional `tags`, an optional `description`, and optional `properties` — arbitrary key-value pairs where each value is a string, number, or boolean (e.g. `{"wheels": 4, "color": "red"}`).

Click **+ Add entity** in the Entities tab to create one from the UI. Enter a name, optional type, optional comma-separated tags, an optional description, and optional properties using the **JSON editor flyout** (click the button to open it; live validation and a **Format** button are provided), then click **Save**. Each save creates a new entity with a unique ID — multiple entities with the same name and type can coexist (e.g. several "Lisa" entries of type "person"). To update an existing entity, use the edit action on its row, or pass its `id` via the API/MCP tool. If entities with the same name and type already exist you will see a warning.

A **search bar** above the entity table lets you filter by name in real time. Results are paginated (20 per page) — use the **← Prev** / **Next →** controls below the table.

Each entity row has an inline **✕ / Delete? / Yes / No** confirmation (no browser dialog).

### Edges

Edges connect two entities. Each edge has a `from`, `to`, `label` (the relationship name), an optional numeric `weight`, an optional `type` for classification (e.g. `causal`, `hierarchical`, `temporal`), optional `tags`, an optional `description`, and optional `properties` (key-value metadata).

Click **+ Add edge** in the Edges tab to create one from the UI. The form accepts:

| Field | Required | Description |
|-------|----------|--------------|
| From | Yes | Search and select the source entity by name using the picker dropdown. |
| Label | Yes | Relationship name, e.g. `depends_on`. |
| To | Yes | Search and select the target entity by name using the picker dropdown. |
| Type | No | Classification, e.g. `causal`, `hierarchical`. |
| Weight | No | Numeric strength (0–1 convention). |
| Tags | No | Comma-separated tags. |
| Description | No | Free-text rationale. |
| Properties | No | Click to open the JSON editor flyout. Enter key-value metadata; live validation and **Format** are provided. |

Click **Save**. If an edge with the same `(from, to, label)` already exists, tags are union-merged, properties are shallow-merged, and weight/type are updated.

The edge table shows entity **names** in the From/To columns (not raw IDs). When editing an edge, the form shows a read-only **From → To** context header so you always know which edge you are changing.

Each edge row has an inline **✕ / Delete? / Yes / No** confirmation (no browser dialog).

---

## Brain — Chrono

The **Chrono** tab stores time-based entries: events, deadlines, plans, predictions, and milestones.

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Short summary of the entry. |
| `type` | Yes | One of `event`, `deadline`, `plan`, `prediction`, `milestone`. |
| `startsAt` | Yes | ISO 8601 start date/time. |
| `endsAt` | No | ISO 8601 end date/time. |
| `status` | No | `upcoming` (default), `active`, `completed`, `overdue`, `cancelled`. |
| `confidence` | No | 0–1 confidence level (useful for predictions). |
| `description` | No | Longer description text. |
| `tags` | No | Categorisation tags (array of strings). |
| `entityIds` | No | Related entity IDs (array). |
| `memoryIds` | No | Related memory IDs (array). |

### Creating from the UI

Click **+ Add entry** in the Chrono tab. Fill in the title, select a type (or type a custom type), pick a start date/time, and optionally add a description, tags, and linked entities using the **entity picker flyout** (search by name, click to link, chips show linked items). Click **Save**.

### Filtering

A filter bar above the chrono table lets you narrow the list by **tag** (text input) and **status** (dropdown). Filters apply immediately and reset pagination. Use **Clear** to remove active filters.

### Pagination

Chrono results are paginated (20 per page). Use the **← Prev** / **Next →** controls below the table.

### Deleting entries

Each chrono row has an inline **✕ / Delete? / Yes / No** confirmation (no browser dialog).

### MCP tools

- `create_chrono` — create a new entry.
- `update_chrono` — update an existing entry (change status, dates, etc.).
- `list_chrono` — list entries, optionally filtered by `status`, `type`, `tags` (ALL), `tagsAny` (ANY), `after`, `before`, or `search`.

The `query` tool also supports `collection: "chrono"` for advanced MongoDB filter queries.

### Sync

Chrono entries sync across brain networks using the same seq-based last-writer-wins protocol as entities and edges. Deleted entries create tombstones that propagate to peers.

---

## Brain — Query

The **Query** panel lets you run structured filter queries directly against any collection in the current space.

Select a **collection** (`memories`, `entities`, `edges`, `chrono`, or `files`) from the dropdown, enter a MongoDB-style filter as JSON, and click **Run**. Results are displayed in a table below.

The filter supports standard MongoDB operators like `$eq`, `$gt`, `$lt`, `$in`, `$regex`, etc. Dangerous operators (`$where`, `$function`) are blocked. Filters deeper than 8 levels are rejected.

Examples:

- All entities of type `service`: `{ "type": "service" }`
- Memories tagged `infra`: `{ "tags": "infra" }`
- Chrono entries after a date: `{ "startsAt": { "$gte": "2026-01-01" } }`

The same functionality is available as the `query` MCP tool and `POST /api/brain/spaces/:spaceId/query` REST endpoint.

---

## Graph

The **Graph** view lets you visually explore the knowledge graph. Select an entity by name and browse its neighbourhood N hops deep.

### Getting started

1. Click **Graph** in the sidebar.
2. Choose a space from the dropdown in the toolbar.
3. Type an entity name in the search bar. An autocomplete dropdown shows matching entities.
4. Click an entity to load its graph neighbourhood.

### Toolbar controls

| Control | Description |
|---------|-------------|
| **Space selector** | Switch between spaces. |
| **Search** | Type-ahead entity search by name. |
| **Depth slider** | Number of hops from the root node (1–10, default 3). |
| **Direction pills** | `Out` = outbound edges only, `In` = inbound only, `Both` = both directions. |
| **Hide labels** | Toggle edge label visibility on dense graphs. |
| **⛶ Fit** | Fit the entire graph into the viewport. |
| **↺ Reset** | Clear the graph and start over. |

### Canvas

Nodes are coloured by entity type using a deterministic palette. The **root node** (the entity you searched for) is larger and has an accent-coloured border.

- **Single-click** a node to select it and open the detail panel below.
- **Double-click** a node to re-root the graph at that node. The browser back button returns to the previous root.
- **Click** an edge to open the edge record in a popup.
- Each node and edge has a **👁** overlay icon. Click it to open the full record in a popup.

When the node cap is reached (the traverse response returns `truncated: true`), a warning banner is overlaid at the top of the canvas: _"⚠ Result truncated — reduce depth or node limit to see full graph"_. The banner is dismissible.

### Detail panel

When a node is selected, a detail panel appears below the canvas. It shows:

- **Header:** entity name, type badge, memory count, chrono count.
- **Filters:** type radio group (All / Memory / Chrono) and a description text filter — both filter client-side without a re-fetch.
- **Table:** unified sortable table with columns **Description · Tags · Properties · Created · 👁**. Click a column header to sort. Click the 👁 button to open the full record in a popup.

### Entry popup

The 👁 button (on table rows, canvas nodes, or canvas edges) opens a shared entry popup that displays all fields of the record.

- **Scalar fields** (string, number, boolean) are shown as labelled form inputs.
- **Object/array fields** are rendered as sub-tables.
- A **Raw JSON** toggle switches to the full JSON view.
- The `_id` field is always read-only.
- If your token has write permission, the popup shows **Validate · Undo · Cancel · Save** buttons. Save PATCHes the record via the correct REST endpoint for the record type.
- If your token is read-only, only a **Close** button is shown.

---

## Files

The file manager lets you browse, upload, download, move, rename, and delete files within each space.

### Uploading

There are two ways to upload:

- **Toolbar button** — click **↑ Upload** and select one or more files.
- **Drag and drop** — drag files from your desktop and drop them anywhere onto the file listing area. The panel highlights with a border when a drop is detected.

Files larger than 10 MB are automatically chunked (5 MB pieces) with a progress bar. Failed chunks retry up to 3 times.

### Actions

- **Preview** — click the 👁 icon on any file row to open the preview pane.
- **Download** — click the **↓** icon on any file row.
- **Rename** — click **Rename** on any row.
- **Delete** — click the **✕** icon and confirm.
- **New Folder** — click **New folder** in the toolbar.

### Breadcrumb navigation

A clickable breadcrumb bar (`root / docs / guides`) appears above the file list. Click any segment to jump to that directory.

---

## File preview

Clicking a filename or the 👁 **Preview** button in the Actions column opens a preview pane instead of downloading.

| File type | Extensions | How it renders |
|-----------|-----------|----------------|
| Text / Code | `.txt`, `.md`, `.json`, `.yaml`, `.yml`, `.ts`, `.js`, `.py`, `.sh`, `.csv`, `.xml`, `.html`, `.css`, `.log`, `.env`, `.toml` | Syntax-highlighted view |
| Image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp` | Inline image scaled to fit |
| PDF | `.pdf` | Embedded viewer |
| Other | Everything else | File metadata with a download button |

### Controls

- **Close**: click ✕, press Escape, or click the overlay backdrop.
- **Navigate**: Arrow keys (↑/↓ or ←/→) cycle through files in the current directory.
- **Download**: always visible in the preview header.

---

## Directory tree sidebar

The file manager has a collapsible directory tree in the left sidebar.

- **Toggle**: click **Show tree** / **Hide tree** in the toolbar. State persists across reloads (localStorage).
- **Lazy loading**: subdirectories load on demand when expanded.
- **Navigation**: clicking a directory navigates the main file listing.
- **Highlighting**: the active directory is highlighted.
- **Auto-refresh**: the tree reloads when you switch spaces or create a folder.

---

## Conflict resolution

When two brains modify the same file before syncing, a conflict record is created.

### Viewing

Open **Files → Conflicts** to see all unresolved conflicts.

### Resolving

Each conflict has four resolution options:

| Action | Result |
|--------|--------|
| **Keep local** | Keeps your file, discards the incoming version |
| **Keep incoming** | Replaces your file with the incoming version |
| **Keep both** | Keeps both files (optionally rename the incoming copy) |
| **Save to space** | Copies the incoming file to a different space, then removes the conflict |

Select an action per row and click **Resolve**, or select multiple conflicts and use the bulk action bar. The **Dismiss** button (✕) removes only the conflict record without touching files.

---

## Settings — Spaces

A space is a fully isolated container for memories, entities, edges, and files. The `general` space is created automatically during setup.

### Creating a space

Open **Settings → Spaces** and fill in:

- **ID** — lowercase alphanumeric + hyphens, max 40 chars.
- **Label** — human-readable display name.
- **MCP Description** — optional. Surfaced to MCP clients as space-level instructions.
- **Min GiB** — optional. Reserve minimum storage for this space.

### Renaming a space

Click the pencil (✎) icon on a space row to rename its ID. Enter a new ID and press Enter or click the check mark. The rename:

- Moves all MongoDB collections (`memories`, `entities`, `edges`, `chrono`, `tombstones`, etc.) to the new prefix.
- Moves the file directory on disk from `/data/files/{old}` to `/data/files/{new}`.
- Updates all network `spaces[]` arrays and adds a `spaceMap` entry (`old → new`) so peers continue to sync correctly.
- Updates all token `spaces[]` scopes that referenced the old ID.

The built-in `general` space cannot be renamed. Renaming to an existing space ID returns `409`.

### Proxy spaces

A proxy space groups multiple real spaces into a single virtual endpoint. Reads aggregate across all members; writes require selecting a target space.

To create a proxy space from the UI, enter comma-separated space IDs in the **Proxy for** field when creating a space. Proxy members must be existing non-proxy spaces (nesting is not allowed).

### Deleting a space

Click the delete button on a space row and confirm by typing the space ID. On a networked brain this opens a vote round so peers can react before removal.

### Wiping a space

Click the ⊘ **Wipe space** button on a space row to erase all data from a space while keeping the space itself (its label, description, config, and settings are preserved).

A confirmation dialog loads the current per-collection document counts (memories, entities, edges, chrono, files) before proceeding so you can confirm the scope of the operation. Click **Wipe space** to confirm.

This is equivalent to `POST /api/admin/spaces/:spaceId/wipe` — see the [Integration Guide](integration-guide.md#wipe-space) for the API reference including partial-type wipes.

### Schema validation

Each space can define a schema that governs what data is accepted. Open a space's settings and switch to the **Schema** tab to configure:

- **Validation mode** — `off` (default), `warn` (accept with warnings), or `strict` (reject violations).
- **Type schemas** — a per-type schema tree (`typeSchemas`) organised by knowledge type (`entity`, `edge`, `memory`, `chrono`) and then by type name. Adding a type name under a knowledge type automatically creates its allowlist entry. For each named type you can configure:
  - **Naming pattern** (entities only) — regex to validate entity `name` (e.g. `service` names must match `^[a-z][a-z0-9-]+$`).
  - **Tag suggestions** — non-enforced tag hints for that specific type shown in the UI.
  - **Property schemas** — per-property value constraints: `type` (string/number/boolean/date), `enum` (allowed values), `minimum`/`maximum` (numeric ranges), `pattern` (regex), `required` (must be present on every write), `default` (value inserted when absent), `mergeFn` (merge hint for entity merges).
- **Global tag suggestions** — non-enforced hints shown in the UI across all knowledge types.

**Schema export / import:** Use the **Export JSON** and **Import JSON** buttons at the top of the Schema tab to download or upload the full `typeSchemas` definition as a JSON file. Schemas are also auto-synced to `schemas/` in the space's file store on every save.

When validation is `strict`, any write (individual or bulk) that violates the schema is rejected with a detailed error listing every violation. When `warn`, writes proceed but the response includes warnings. The `validate-schema` endpoint lets you dry-run a proposed schema change against existing data — see the [Integration Guide](integration-guide.md#validate-schema-dry-run).

Schema validation applies equally to REST API writes, MCP tool calls, and bulk operations.

### Schema Library

The **Schema Library** (accessible from the main navigation, under Workspace) is an instance-level store of reusable `TypeSchema` definitions. Instead of copying the same schema into every space, you define it once in the library and reference it from each space.

**Creating a library entry:** Open **Schema Library** → **+ New entry**. Give it a unique name (e.g. `service-v1`), select the knowledge type and type name it is intended for, then fill in the same constraints you would enter in a space's schema editor: naming pattern, tag suggestions, and property schemas.

**Referencing a library entry from a space:** In the space's schema tab, each type row has a **← Lib** button that opens a picker showing matching library entries. Choose **Import inline** to copy the schema directly, or **Use $ref** to store a reference (`library:<name>`) instead. Spaces that use `$ref` automatically pick up library edits without any re-configuration.

**Exporting a library entry to a space (and vice-versa):** In the space's schema tab, click **→ Lib** on any type row to save that type's current schema to the library (you will be prompted for a name). Use the download icon (↓) in the library list to export an entry as a JSON file, or the **↑ Import from file** button to bulk-import entries from a JSON file.

**JSON format for `$ref`:**

```json
{
  "meta": {
    "typeSchemas": {
      "entity": {
        "service": { "$ref": "library:service-v1" }
      }
    }
  }
}
```

Editing a library entry takes effect immediately for all spaces that reference it. If a `$ref` points to a non-existent entry, the type is treated as having an empty schema (no constraints).

### Exporting a space

Use the REST API to export a full space dump:

```
GET /api/admin/spaces/:spaceId/export
```

Returns all memories, entities, edges, chrono entries, and file metadata as a single JSON document. Embedding vectors are stripped so the export is model-independent. Binary file content is not included.

### Importing into a space

```
POST /api/admin/spaces/:spaceId/import
```

Accepts the same JSON format as the export. Each document is matched by `_id` — existing documents are replaced, new ones are inserted. After importing, run a reindex (`POST /api/brain/spaces/:spaceId/reindex`) to rebuild embedding vectors.

---

## Settings — Tokens

All API and MCP access requires a Bearer PAT (`ythril_` prefix). Tokens are bcrypt-hashed and never stored or logged in plaintext.

### Token types

| Type | Access |
|------|--------|
| Admin | Full access — token management, space CRUD, network management |
| Non-admin | Data only — brain, files, MCP; cannot manage tokens or networks |
| Read-only | Search and read only — all mutations blocked |
| Space-scoped | Restricted to listed spaces; all others invisible |

The web UI supports creating all token types: admin, non-admin, read-only, and space-scoped.

### Actions

- **Create** — provide a name and optional expiry date, then choose a **permission level** (Read-only, Standard, or Admin) using the radio buttons, and optionally restrict the token to specific spaces using the checkbox list. The plaintext is shown **once** — copy it immediately.
- **Rotate** (↺) — generates a new secret, invalidating the old one instantly. The new plaintext is shown once.
- **Revoke** (✕) — permanently deletes the token.

The token you are currently logged in with is marked **(you)** in the list. Read-only tokens show a yellow **read-only** badge next to the name.

---

## Settings — MFA

MFA adds an optional TOTP requirement on admin mutations (creating tokens, managing spaces). Read-only and data-plane operations are unaffected.

### Enrolling

1. Open **Settings → MFA** and click **Enable MFA**.
2. Scan the QR code with your authenticator app (Google Authenticator, Authy, 1Password, Bitwarden, etc.). The QR is generated entirely in-browser — the TOTP secret never leaves your machine.
3. Enter a 6-digit code and click **Confirm**.
4. A green **Enabled** badge appears.

> The base32 key is shown only during enrollment. If you need it later, disable and re-enroll.

### Daily use

When you perform an admin action (e.g. create a token), the UI automatically prompts for a TOTP code. Once entered, the code is cached in memory for 15 minutes so you aren't re-prompted on every click.

### Disabling

Click **Disable MFA** and confirm. No TOTP code is needed — this is the recovery path if you lose your authenticator. You must still have a valid admin PAT.

### Recovery

If you've lost your authenticator app, disable MFA from the UI (or API) using your admin token. Then re-enroll with a new authenticator.

If you've also lost all admin tokens: restore a backup of `config/secrets.json` or start fresh with `docker compose down -v && docker compose up`.

---

## Settings — Networks

Networks sync specific spaces between brains. Each network has a governance type that controls how members join and leave.

### Governance types

| Type | Join approval | Best for |
|------|--------------|----------|
| **Closed** | All members unanimous | Personal multi-device |
| **Democratic** | Majority vote, no vetoes | Small teams |
| **Club** | Inviter decides alone | Open collaboration |
| **Braintree** | All ancestors to root | Hierarchical orgs |
| **Pub/Sub** | Automatic (no approval) | Public distribution, documentation |

For full governance rules see [network-types.md](network-types.md).

### Creating a network

1. Open **Settings → Networks**.
2. Enter a label, choose a type, enter space IDs (comma-separated).
3. Set a voting deadline (hours) and optional cron sync schedule.
4. Click **Create network**.

### Inviting another brain

1. Expand the network card.
2. Click **Generate invite** → **Copy bundle**.
3. Send the JSON bundle to the other brain's admin out-of-band.

The invite expires after 24 hours. The bundle contains an RSA-4096 public key and a one-time handshake ID — no token is included.

### Joining a network

1. Open **Settings → Networks → Join an existing network**.
2. Paste the invite bundle JSON.
3. Enter this brain's publicly reachable URL (e.g. `https://brain-b.example.com`).
4. If the remote network includes spaces that already exist locally, a **collision resolution** dialog appears for each overlapping space. Choose:
   - **Merge** — sync into the existing local space directly.
   - **Alias** — create a new local space with a different ID. Enter the new name in the text field.
5. Click **Join network**.

The RSA handshake runs server-to-server. Sync tokens are exchanged encrypted — never visible in the UI.

If join fails with a peer URL validation error (private IP, localhost, embedded credentials), see [Integration Guide — Join Troubleshooting: private or local URLs rejected](integration-guide.md#join-troubleshooting-private-or-local-urls-rejected).

Space aliases are stored as a `spaceMap` on the network config (`remote-id → local-id`). The sync engine transparently translates between remote and local space IDs during pull and push.

### Enable Networks wizard (localhost/private URL)

If this brain is opened via `localhost` or another private URL, the Networks header shows **Enable Networks** instead of **Create Network** / **Join Network**.

Why:

- Peer URL validation blocks private/loopback targets for network join/sync endpoints.
- A public HTTPS hostname is required for cross-instance networking.

Wizard flow:

1. Explains why a public URL is needed and what risks apply.
2. Asks for a hostname you control in Cloudflare and auto-detects OS (`Windows` or `Linux`, editable).
3. Generates platform-specific Cloudflare Tunnel command steps.
4. Optional autostart command is included.
5. After setup, use `https://<hostname>` as this brain's URL in join flows.

Notes:

- The hostname must be inside a DNS zone you control in Cloudflare.
- Host-level install/service commands are never executed directly by browser code.
- Optional: when a trusted local connector service is configured, the wizard can run the setup automatically through that connector.

If you hit URL validation errors while joining, see [Integration Guide — Join Troubleshooting: private or local URLs rejected](integration-guide.md#join-troubleshooting-private-or-local-urls-rejected).

### Managing members

Expand a network card to see its member list. Click **×** on any member to remove them.

| Network type | What happens on remove |
|---|---|
| Closed | Immediate removal |
| Democratic / Club | Vote round opened |
| Braintree | Ancestor approval required |
| Pub/Sub | Publisher removes directly (no vote) |

### Sync schedule

Enter a cron expression in the **Sync** section (e.g. `*/5 * * * *` for every 5 minutes). Leave empty for manual-only. Click **Sync now** for an immediate cycle.

### Sync history

Expand a network card and click **Sync History**. Each entry shows:

- **Timestamp** and **status badge** (green/yellow/red)
- **Pulled / pushed counts** — memories, entities, edges, files
- **Errors** — expandable list (if any)

### Governance and voting

When a pending vote exists, expand the network card and scroll to **Open votes**. Each entry shows the operation type and subject. Click **✓ Yes** or **✗ No**. Votes propagate to peers during the next sync.

| Type | Passes when |
|------|-------------|
| Closed | All members vote yes |
| Democratic | Majority yes, no vetoes |
| Braintree | All ancestors vote yes |

A single **veto** immediately fails the round.

### Braintree setup

1. **Root**: create a braintree network.
2. **First child**: Root invites Brain B → B joins → auto-approved (single ancestor).
3. **Grandchild**: Brain B invites Brain C → C joins → needs approval from both B and Root. Brain B auto-votes yes; Root sees the vote on next sync and approves from **Open votes**.

### Forking a network

If you've been ejected or want to start fresh from a snapshot, you can fork via the API. The fork gets a new ID, no members, and you become the root. See [integration-guide.md](integration-guide.md#fork-a-network) for the API call.

### Leaving a network

Click **Leave network** at the bottom of the network card. This notifies all peers and removes the network config locally. Your data in the network's spaces is kept.

---

## Settings — Storage

**Settings → Storage** shows disk usage per space and against configured quota limits.

| Threshold | Behaviour |
|-----------|----------|
| Below soft limit | Normal |
| Above soft limit | Writes succeed with a warning |
| Above hard limit | Writes rejected (HTTP 507) |

Quota limits are configured in `config.json` — see [integration-guide.md](integration-guide.md#storage-quotas) for details.

---

## Settings — Audit Log

**Settings → Audit Log** (admin only) shows a searchable, filterable log of every authenticated API operation.

### Filters

| Filter | Description |
|--------|-------------|
| After / Before | Date-time range |
| Operation | Dropdown of tracked operation types (e.g. `memory.create`, `auth.failed`) |
| Space | Filter by space |
| Status | HTTP status code (200, 201, 400, 401, 403, 404, 500) |
| IP | Client IP address |

### Table columns

Timestamp, Token/User, Operation, Space, Status (colour-coded badge), IP, Duration. Click a row to see the full JSON entry.

### Export

Download the current filtered view as **JSON** or **CSV**.

### Configuration

The audit log is always enabled. Configure behaviour in `config.json`:

```json
{
  "audit": {
    "logReads": false,
    "retentionDays": 90
  }
}
```

- `logReads: false` (default) — only write operations and auth failures are logged
- `logReads: true` — read operations (recall, query, list, traverse, stats) are also logged
- `retentionDays` — entries older than this are automatically purged

---

## Settings — Webhooks

**Settings → Webhooks** (admin only) lets you subscribe external systems to real-time HTTP POST notifications when write events occur on Ythril spaces.

### Creating a webhook

1. Click **+ New Webhook**
2. Enter a target **URL** (must be HTTPS, must not target private/reserved IPs)
3. Enter a **secret** (minimum 8 characters) — used to sign payloads with HMAC-SHA256
4. Optionally restrict to specific **spaces** and **event types**
5. Click **Create**

### Event types

Webhooks fire on write events across 5 domains:

| Domain | Events |
|--------|--------|
| Memory | `memory.created`, `memory.updated`, `memory.deleted` |
| Entity | `entity.created`, `entity.updated`, `entity.deleted`, `entity.merged` |
| Edge | `edge.created`, `edge.updated`, `edge.deleted` |
| Chrono | `chrono.created`, `chrono.updated`, `chrono.deleted` |
| File | `file.created`, `file.updated`, `file.deleted` |

### Delivery guarantees

- **At-least-once** delivery with up to 6 retries (10s → 30s → 1m → 5m → 30m → 1h)
- Each delivery is signed with `X-Ythril-Signature: sha256=<HMAC-SHA256 hex digest>`
- Delivery history is visible per webhook

### Testing

Use the **Test** button to send a `test.ping` event to verify connectivity.

---

## Settings — About

The **About** tab shows:

| Field | Description |
|-------|-------------|
| Instance Label | Name configured during setup |
| Instance ID | UUID identifying this brain |
| Version | Server version |
| Uptime | Time since server started |
| MongoDB Version | Connected MongoDB version |
| Disk Usage | Visual bar of used / total space |
| Server Log | Last 200 lines, auto-refreshed every 15 seconds |

---

## Connecting MCP clients

Each space exposes an MCP (Model Context Protocol) endpoint at `/mcp/{spaceId}`. Connect your AI assistant to give it direct access to your brain's memories, files, and knowledge graph.

### Configuration

Add to your MCP client config (Claude Desktop, Cursor, Windsurf, VS Code, etc.):

```json
{
  "mcpServers": {
    "ythril-general": {
      "url": "http://localhost:3200/mcp/general",
      "headers": {
        "Authorization": "Bearer ythril_yourTokenHere"
      }
    }
  }
}
```

Replace `general` with any space ID. Add multiple entries to give the agent access to multiple spaces. A single token works for all entries if it has access to all listed spaces.

### Space descriptions and schema as instructions

If a space has a `description`, it is sent to the MCP client as `instructions` during the handshake. This tells the AI agent what the space contains before it calls any tools. When a space has a schema defined (via `meta`), a compact summary of allowed types, labels, naming patterns, and required properties is appended — so the LLM knows the rules before its first write.

### Available tools

| Tool | Description |
|------|-------------|
| `remember` | Store a memory with optional tags, entity links, `description`, and `properties` |
| `update_memory` | Update an existing memory's fact, tags, entity links, or remove fields via `deleteFields` |
| `delete_memory` | Delete a memory by ID |
| `recall` | Semantic search within the current space. Optional `tags` and `types` filters narrow results; `minPerType` guarantees a minimum result count per knowledge type; `minScore` sets a similarity threshold |
| `recall_global` | Semantic search across all accessible spaces. Same parameters as `recall` |
| `query` | Structured filter query (read-only) — supports `memories`, `entities`, `edges`, `chrono`, and `files` collections |
| `find_similar` | Find entries with high vector similarity to an existing entry by ID — uses stored embedding, no re-embedding |
| `get_stats` | Return counts of memories, entities, edges, chrono entries, and files |
| `get_space_meta` | Return the full space schema, purpose, usage notes, and stats |
| `upsert_entity` | Create or update a named entity (`name`, `type`, `tags`, `description`, `properties`) |
| `update_entity` | Update an existing entity by ID; supports `deleteFields` for field removal |
| `merge_entities` | Merge two entities — relink references, resolve per-property conflicts, delete absorbed entity |
| `find_entities_by_name` | Find all entities with an exact name match |
| `upsert_edge` | Create or update a directed relationship (`label`, `type`, `weight`, `tags`, `description`, `properties`) |
| `update_edge` | Update an existing edge by ID; supports `deleteFields` for field removal |
| `traverse` | BFS graph traversal — follow edges from a starting entity up to N hops |
| `create_chrono` | Create a chrono entry (event, deadline, plan, prediction, milestone) |
| `update_chrono` | Update an existing chrono entry |
| `list_chrono` | List chrono entries with filters for status, type, tags, date range, and text search |
| `bulk_write` | Batch-upsert memories, entities, edges, and chrono entries in a single call |
| `read_file` | Read a file from the space |
| `write_file` | Write a file to the space (optional `description`, `tags`, and `properties` stored as metadata) |
| `list_dir` | List directory contents |
| `delete_file` | Delete a file |
| `create_dir` | Create a directory |
| `move_file` | Move or rename a file/directory |
| `update_space` | Update space label and/or description (admin only) |
| `wipe_space` | Wipe all or specific collection types (admin only) |
| `list_peers` | List all configured sync peers |
| `sync_now` | Trigger immediate sync |

### Read-only tokens

When connected with a `readOnly` token, mutating tools are hidden from `tools/list` and rejected if called directly. Read-only tools (`recall`, `recall_global`, `query`, `find_similar`, `get_stats`, `get_space_meta`, `find_entities_by_name`, `list_chrono`, `read_file`, `list_dir`, `list_peers`, `traverse`) work normally.

### Proxy spaces

When connected to a proxy space, read tools aggregate across all member spaces automatically. Write tools require an additional `targetSpace` argument specifying which member space to write to.
