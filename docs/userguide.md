# Ythril User Guide

> How to use the Ythril web interface and connect MCP clients.

For hosting, deployment, and API reference see [integration-guide.md](integration-guide.md).
For contributing and building from source see [contribution-guide.md](contribution-guide.md).

---

## Table of Contents

1. [Logging in](#logging-in)
2. [Brain — Memories](#brain--memories)
3. [Brain — Entities & Edges](#brain--entities--edges)
4. [Brain — Chrono](#brain--chrono)
5. [Files](#files)
6. [File preview](#file-preview)
7. [Directory tree sidebar](#directory-tree-sidebar)
8. [Conflict resolution](#conflict-resolution)
9. [Settings — Spaces](#settings--spaces)
10. [Settings — Tokens](#settings--tokens)
11. [Settings — MFA](#settings--mfa)
12. [Settings — Networks](#settings--networks)
13. [Settings — Storage](#settings--storage)
14. [Settings — About](#settings--about)
15. [Connecting MCP clients](#connecting-mcp-clients)

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
|-------|----------|-------------|
| Fact | Yes | The statement to remember. |
| Tags | No | Comma-separated categorisation tags. |
| Entity IDs | No | Comma-separated entity IDs to link. |
| Description | No | Free-text context or rationale behind the fact. |
| Properties | No | JSON object of key-value metadata, e.g. `{"source": "docs", "confidence": 0.9}`. |

Click **Save**. The memory is embedded and stored immediately. `description` and `properties` are also shown on each memory row in the list.

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

Click **+ Add entity** in the Entities tab to create one from the UI. Enter a name, optional type, optional comma-separated tags, an optional description, and optional properties as a JSON object, then click **Save**. If an entity with the same `(name, type)` already exists, tags are merged and properties are shallow-merged (new keys added, existing keys overwritten).

A **search bar** above the entity table lets you filter by name in real time. Results are paginated (20 per page) — use the **← Prev** / **Next →** controls below the table.

Each entity row has an inline **✕ / Delete? / Yes / No** confirmation (no browser dialog).

### Edges

Edges connect two entities. Each edge has a `from`, `to`, `label` (the relationship name), an optional numeric `weight`, an optional `type` for classification (e.g. `causal`, `hierarchical`, `temporal`), optional `tags`, an optional `description`, and optional `properties` (key-value metadata).

Click **+ Add edge** in the Edges tab to create one from the UI. The form accepts:

| Field | Required | Description |
|-------|----------|-------------|
| From | Yes | Source entity name or ID. |
| Label | Yes | Relationship name, e.g. `depends_on`. |
| To | Yes | Target entity name or ID. |
| Type | No | Classification, e.g. `causal`, `hierarchical`. |
| Weight | No | Numeric strength (0–1 convention). |
| Tags | No | Comma-separated tags. |
| Description | No | Free-text rationale. |
| Properties | No | JSON key-value metadata. |

Click **Save**. If an edge with the same `(from, to, label)` already exists, tags are union-merged, properties are shallow-merged, and weight/type are updated.

The edge table shows a **Tags** column and renders `description` as a subtitle below the relation label. Results are paginated (20 per page) with **← Prev** / **Next →** controls.

Each edge row has an inline **✕ / Delete? / Yes / No** confirmation (no browser dialog).

---

## Brain — Chrono

The **Chrono** tab stores time-based entries: events, deadlines, plans, predictions, and milestones.

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Short summary of the entry. |
| `kind` | Yes | One of `event`, `deadline`, `plan`, `prediction`, `milestone`. |
| `startsAt` | Yes | ISO 8601 start date/time. |
| `endsAt` | No | ISO 8601 end date/time. |
| `status` | No | `upcoming` (default), `active`, `completed`, `overdue`, `cancelled`. |
| `confidence` | No | 0–1 confidence level (useful for predictions). |
| `description` | No | Longer description text. |
| `tags` | No | Categorisation tags (array of strings). |
| `entityIds` | No | Related entity IDs (array). |
| `memoryIds` | No | Related memory IDs (array). |

### Creating from the UI

Click **+ Add entry** in the Chrono tab. Fill in the title, select a kind (or type a custom kind), pick a start date/time, and optionally add a description, tags, and linked entity IDs. Click **Save**.

### Filtering

A filter bar above the chrono table lets you narrow the list by **tag** (text input) and **status** (dropdown). Filters apply immediately and reset pagination. Use **Clear** to remove active filters.

### Pagination

Chrono results are paginated (20 per page). Use the **← Prev** / **Next →** controls below the table.

### Deleting entries

Each chrono row has an inline **✕ / Delete? / Yes / No** confirmation (no browser dialog).

### MCP tools

- `create_chrono` — create a new entry.
- `update_chrono` — update an existing entry (change status, dates, etc.).
- `list_chrono` — list entries, optionally filtered by `status`, `kind`, `tags` (ALL), `tagsAny` (ANY), `after`, `before`, or `search`.

The `query` tool also supports `collection: "chrono"` for advanced MongoDB filter queries.

### Sync

Chrono entries sync across brain networks using the same seq-based last-writer-wins protocol as entities and edges. Deleted entries create tombstones that propagate to peers.

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

Space aliases are stored as a `spaceMap` on the network config (`remote-id → local-id`). The sync engine transparently translates between remote and local space IDs during pull and push.

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

### Space descriptions as instructions

If a space has a `description`, it is sent to the MCP client as `instructions` during the handshake. This tells the AI agent what the space contains before it calls any tools.

### Available tools

| Tool | Description |
|------|-------------|
| `remember` | Store a memory with optional tags, entity links, `description`, and `properties` |
| `update_memory` | Update an existing memory's fact, tags, or entity links |
| `delete_memory` | Delete a memory by ID |
| `recall` | Semantic search within the current space. Optional `tags` and `types` filters narrow results; `minPerType` guarantees a minimum result count per knowledge type |
| `recall_global` | Semantic search across all accessible spaces. Accepts the same `tags`, `types`, and `minPerType` parameters as `recall` |
| `query` | Structured filter query (read-only) — supports `memories`, `entities`, `edges`, `chrono`, and `files` collections |
| `get_stats` | Return counts of memories, entities, edges, chrono entries, and files |
| `upsert_entity` | Create or update a named entity (`name`, `type`, `tags`, `description`, `properties`) |
| `upsert_edge` | Create or update a directed relationship (`label`, `type`, `weight`, `tags`, `description`, `properties`) |
| `create_chrono` | Create a chrono entry (event, deadline, plan, prediction, milestone) |
| `update_chrono` | Update an existing chrono entry |
| `list_chrono` | List chrono entries, optionally filtered by status, kind, or tags |
| `read_file` | Read a file from the space |
| `write_file` | Write a file to the space (optional `description`, `tags`, and `properties` stored as metadata) |
| `list_dir` | List directory contents |
| `delete_file` | Delete a file |
| `create_dir` | Create a directory |
| `move_file` | Move or rename a file/directory |
| `list_peers` | List all configured sync peers |
| `sync_now` | Trigger immediate sync |

### Read-only tokens

When connected with a `readOnly` token, mutating tools are hidden from `tools/list` and rejected if called directly. Read-only tools (`recall`, `recall_global`, `query`, `get_stats`, `list_chrono`, `read_file`, `list_dir`, `list_peers`) work normally.

### Proxy spaces

When connected to a proxy space, read tools aggregate across all member spaces automatically. Write tools require an additional `targetSpace` argument specifying which member space to write to.
