# Ythril User Guide

> A practical guide to the Ythril web interface for everyday users.

For deployment and API reference see [integration-guide.md](integration-guide.md).
For setting up a workstation quickly see [workstation-mode-guide.md](workstation-mode-guide.md).

---

## Table of Contents

1. [Logging in](#logging-in)
2. [Navigation](#navigation)
3. [Spaces — what they are](#spaces--what-they-are)
4. [Brain](#brain)
   - [Memories](#memories)
   - [Entities](#entities)
   - [Edges](#edges)
   - [Chrono](#chrono)
   - [Query](#query)
5. [Graph](#graph)
6. [Files](#files)
7. [Conflict resolution](#conflict-resolution)
8. [Schema Library](#schema-library)
9. [Settings — Spaces](#settings--spaces)
10. [Settings — Tokens](#settings--tokens)
11. [Settings — MFA](#settings--mfa)
12. [Settings — Networks](#settings--networks)
13. [Settings — Storage](#settings--storage)
14. [Settings — Data](#settings--data)
15. [Settings — Audit Log](#settings--audit-log)
16. [Settings — Webhooks](#settings--webhooks)
17. [Settings — About](#settings--about)
18. [Connecting an AI assistant (MCP)](#connecting-an-ai-assistant-mcp)

---

## Logging in

Open your instance URL in a browser (e.g. `http://localhost:3200`). Enter your access token — the one you received during setup — and click **Log in**.

If your organisation uses single sign-on (SSO), you will be redirected to your identity provider automatically. After authenticating there you land back in Ythril already logged in.

To sign in with a token when SSO is active, go to `/login?local`.

Clicking **Log out** in the sidebar footer clears the session.

---

## Navigation

The left sidebar is the main navigation. It is divided into two sections:

**Workspace**
- **Brain** — store and search everything you know
- **Graph** — visualise how entities connect
- **Files** — manage uploaded documents and files
- **Schema Library** — reusable data definitions shared across spaces

**Admin** (admin tokens only)
- **Settings** → Tokens, Spaces, Networks, Storage, Audit Log, Webhooks, About, Preferences

A space selector at the top of the sidebar (or inside each page) lets you switch between spaces. Everything you see is scoped to the selected space.

A red badge appears next to **Files** when there are file conflicts waiting to be resolved.

---

## Spaces — what they are

A **space** is a completely separate container of data — memories, entities, edges, chrono entries, and files. Think of it as a project folder or a context boundary.

The `general` space is created automatically on first run. Admins can create additional spaces in **Settings → Spaces**. Your access token determines which spaces you can see; if a space is not in your token's scope it is invisible to you.

---

## Brain

The Brain is where all your knowledge lives. It has five tabs: **Memories**, **Entities**, **Edges**, **Chrono**, and **Query**.

Five stat pills at the top of the page show the current counts for each collection in the selected space.

If the search index needs rebuilding (for example after upgrading the embedding model), an **⚠ Needs reindex** banner appears. Click **Reindex now** to rebuild it.

### Memories

Memories are the core knowledge unit — plain-language statements you want to remember.

**Creating a memory:** Click **+ Add memory**. Fill in:

| Field | Notes |
|-------|-------|
| **Fact** | The statement to store. Required. |
| **Tags** | Comma-separated keywords for filtering. |
| **Entities** | Click to open the entity picker. Search by name and click to link. Linked items appear as chips. |
| **Description** | Optional context or rationale. |
| **Properties** | Click to open the JSON editor. Enter any key-value pairs you want to attach. |

Click **Save**. The memory is indexed immediately and available for search.

**Searching:** Type a natural-language question or phrase in the search bar and press Enter. Ythril uses semantic (meaning-based) search to find the most relevant memories.

**Filtering:** Click any tag or entity badge on a memory row to filter the list. Active filters appear as chips above the table. Click **×** on a chip to remove it, or **Clear all** to reset.

**Deleting:** Each row has a **✕** button. A small inline confirmation appears — click **Yes** to confirm, **No** to cancel.

**Wiping everything:** Click **Wipe all** in the toolbar. You will be asked to type the space ID to confirm. This removes all memories in the space.

---

### Entities

Entities are named concepts — people, services, projects, tools, anything you want to connect knowledge around.

Each entity has a **name**, optional **type** (e.g. `person`, `service`), optional **tags**, an optional **description**, and optional **properties** (key-value pairs like `{ "version": "3.0", "active": true }`).

**Creating an entity:** Click **+ Add entity**, fill in the fields, and click **Save**.

**Searching:** The search bar above the table filters by name in real time.

**Editing:** Click the edit icon on any row to update it.

**Deleting:** Each row has an inline **✕ → confirm** flow.

Results are paginated — use **← Prev / Next →** to page through them.

---

### Edges

Edges connect two entities and describe the relationship between them (e.g. *service-a* `depends_on` *service-b*).

Each edge has a **from** entity, a **to** entity, a **label** (the relationship name), and optional **type**, **weight**, **tags**, **description**, and **properties**.

**Creating an edge:** Click **+ Add edge**. Use the entity pickers to select the source and target, type a label, and click **Save**.

**Editing / Deleting:** Same as entities — edit icon or inline ✕ confirm.

---

### Chrono

Chrono stores time-anchored entries: events, deadlines, plans, predictions, and milestones.

**Creating an entry:** Click **+ Add entry**. Required fields are **title**, **type**, and **starts at** (date and time). You can also add a description, tags, status, and linked entities.

**Filtering:** The filter bar above the table lets you narrow by tag text and status. Filters apply immediately.

**Deleting:** Inline ✕ confirmation per row.

---

### Query

The Query panel lets you run structured searches across any collection in the current space.

Select a collection (`memories`, `entities`, `edges`, `chrono`, or `files`), enter a filter as JSON, and click **Run**. Results appear in a table below.

Example — find all entities of type `service`:
```json
{ "type": "service" }
```

Example — find memories tagged `infra`:
```json
{ "tags": "infra" }
```

---

## Graph

The Graph view lets you explore how entities relate to each other visually.

**Getting started:**
1. Click **Graph** in the sidebar.
2. Select a space from the toolbar.
3. Type an entity name in the search bar and click the result to load its graph.

**Toolbar controls:**

| Control | What it does |
|---------|-------------|
| **Search** | Find and load an entity as the root node |
| **Depth** | How many hops out from the root to show (1–10) |
| **Direction** | Show outbound edges, inbound edges, or both |
| **Hide labels** | Toggle edge label text on dense graphs |
| **Fit** | Zoom to fit the whole graph in view |
| **Reset** | Clear the graph |

**Interacting with the graph:**
- **Single-click** a node to select it and open the detail panel below.
- **Double-click** a node to make it the new root.
- **Click** an edge to see its details in a popup.
- The **👁** icon on nodes and edges opens a full detail popup.

The detail panel below the canvas shows all memories and chrono entries linked to the selected entity. Use the type filter and description filter to narrow what you see.

---

## Files

The file manager lets you upload, download, organise, and preview files within each space.

**Uploading:** Click **↑ Upload** in the toolbar, or drag and drop files directly onto the file list. Large files are uploaded in chunks automatically.

**Actions per row:**

| Action | How |
|--------|-----|
| Preview | Click the file name or the 👁 icon |
| Download | Click the ↓ icon |
| Rename | Click **Rename** |
| Delete | Click ✕ and confirm |

**New folder:** Click **New folder** in the toolbar.

**Navigation:** A breadcrumb bar (`root / docs / guides`) at the top lets you jump to any parent directory. The **tree sidebar** (toggle with **Show tree** / **Hide tree**) provides a full directory view.

### File preview

Clicking a file name or 👁 opens an inline preview pane:

| Type | How it renders |
|------|---------------|
| Text, code, Markdown, JSON, YAML… | Syntax-highlighted |
| Images (.png, .jpg, .gif, .webp, .svg…) | Inline image |
| PDF | Embedded viewer |
| Everything else | File info + download button |

Press **Escape** or click the backdrop to close. Use arrow keys to move to the previous or next file in the directory.

---

## Conflict resolution

When two connected brains modify the same file before syncing, a conflict is created. The sidebar shows a red badge on Files when conflicts are waiting.

Open **Files → Conflicts** to see them. For each conflict choose what to do:

| Option | Result |
|--------|--------|
| **Keep local** | Your version wins, the incoming version is discarded |
| **Keep incoming** | The incoming version replaces yours |
| **Keep both** | Both versions are kept (you can rename the incoming copy) |
| **Save to space** | The incoming version is copied to a different space, then the conflict is removed |

**Dismiss** (✕) removes the conflict record without changing any files.

---

## Schema Library

The Schema Library is an instance-wide store of reusable data definitions. Instead of copying the same schema into every space, define it once here and reference it from any space.

Open **Schema Library** from the sidebar (under Workspace).

### My Library tab

This tab lists all schema definitions on this instance.

**Browsing:** Use the search bar to filter by name or description. Use the type filter pills (entity / memory / edge / chrono) to narrow by knowledge type.

**Creating an entry:** Click **+ New entry**. Fill in:
- **Default Type Name** — the display name (e.g. `Service`). A unique identifier is derived from it automatically.
- **Knowledge Type** — which kind of data this schema applies to.
- **Description** — optional, surfaced to AI assistants.
- **Naming pattern** — an optional regular expression that entity names must match.
- **Tag suggestions** — hints shown to users when entering tags.
- **Property schemas** — click **+ Add property** to define properties with optional type, constraints, and whether they are required.

Click anywhere on a card to open and edit it. Changes save and close automatically.

**Publishing:** Click the globe icon on a card to make the entry visible to other Ythril instances. The icon turns accented when published. Click again to unpublish. No space data is ever exposed — only the schema definition.

**Sharing your library:** On the My Library tab, the search bar row also shows your instance's public library URL. Click **Copy** to copy it. Other instances can paste this URL when adding a catalog link.

To protect your library endpoint with a token (e.g. when your instance sits behind Cloudflare Access), click **Create token**. Give the token a name and click **Create** — the value is shown once. Paste it into the **Library Access Token** field when the consuming instance adds a catalog link pointing to you.

**Deleting:** Click the trash icon. If spaces currently reference the entry, a dialog shows which ones and offers to unlink them automatically before deleting.

### Foreign Catalogs tab

This tab lets you link to other Ythril instances' public schema libraries and import their definitions.

**Adding a catalog:** Click **Add Catalog**. Enter a short ID (e.g. `acme`), the base URL of the remote instance (e.g. `https://brain.acme.example`), and an optional description. If the remote instance requires authentication on its public library endpoint (indicated by a lock icon or communicated by the owner), also enter the **Library Access Token** they issued you.

**Browsing:** Click **Browse** on a catalog card to see all published entries on that remote instance.

**Importing:** Click **Import** next to any entry. It is copied into your local library tagged with the source catalog for traceability.

**Removing a catalog link:** Click the trash icon on the catalog card. Previously imported entries stay in your library.

---

## Settings — Spaces

Open **Settings → Spaces** to manage all spaces on this instance.

### Creating a space

Click **+ Create space**. Fill in:

- **Display Name** — the human-readable label shown everywhere in the UI.
- **ID** — optional. Short lowercase identifier (auto-generated from the name if left blank).
- **Max Storage (GiB)** — optional quota limit. Leave blank for unlimited.
- **Purpose** — optional description of what this space is for. Visible to AI assistants.

### Space settings

Click the gear icon on any space row to open its settings panel. Changes save and close automatically.

**General tab:** Update the display name, purpose, usage notes for AI assistants, and storage quota.

**Schema tab:** Define what data this space accepts.

- **Validation mode** — `off` means anything goes; `warn` lets writes through but flags violations; `strict` blocks invalid writes entirely.
- **Strict linkage** — when on, references between items must be valid IDs and deletion of referenced items is blocked.
- **Type schemas** — define per-type rules under each knowledge type (entity, memory, edge, chrono). For each named type you can set:
  - **Naming pattern** — a regex the name must match.
  - **Tag suggestions** — hints shown in the tag input.
  - **Property schemas** — rules for each property field (type, allowed values, min/max, pattern, required, default).
- **From Lib** — import a schema from the Schema Library. The type row shows a badge and stays in sync with the library automatically.
- **From File** — import a schema from a previously exported JSON file.
- **Save to Lib** — save the current type schema to the Schema Library for reuse in other spaces.

**Danger tab:** Rename the space ID, wipe all data, or delete the space entirely.

### Renaming a space

Click the pencil icon on a space row to rename its ID. All data, files, token scopes, and network sync mappings are updated automatically.

### Deleting a space

In the space's settings panel, open the **Danger** tab and click **Delete space**. You will be asked to type the space ID to confirm.

### Wiping a space

In the **Danger** tab, click **Wipe space**. A confirmation dialog shows how many items are in each collection before you proceed. The space itself (its settings, label, schema) is kept — only the data inside it is removed.

---

## Settings — Tokens

All access to Ythril — from the web UI, REST API, or AI assistants — requires an access token.

**Token types:**

| Type | Access |
|------|--------|
| Admin | Everything, including token and space management |
| Standard | Brain, files, and MCP tools; cannot manage tokens, spaces, or networks |
| Read-only | Search and read only; all writes blocked |
| Library Access | Public schema library endpoints only (`/api/schema-library/public*`); no space data, no brain, no files |

Tokens can also be **space-scoped** — restricted to a specific list of spaces. Spaces outside that list are invisible to the token. Library Access tokens are always space-less.

### Creating a token

Click **+ New token**. Enter a name, choose a permission level, optionally set an expiry date, and optionally restrict it to specific spaces. To create a library access token (for sharing your schema library with other instances), enable **Library Access** — space selection and write access are then disabled automatically. Click **Create** — the token value is shown **once**. Copy it immediately.

### Rotating a token

Click the ↺ icon on any token row. A new secret is generated; the old one stops working immediately. The new value is shown once.

### Revoking a token

Click the ✕ icon and confirm. The token is deleted and can never be used again.

Your current session token is marked **(you)** in the list.

---

## Settings — MFA

MFA adds a one-time code requirement for admin actions (creating tokens, managing spaces). Normal data operations are not affected.

### Enrolling

1. Open **Settings → MFA** and click **Enable MFA**.
2. Scan the QR code with an authenticator app (Google Authenticator, Authy, 1Password, Bitwarden, etc.).
3. Enter the 6-digit code shown in the app and click **Confirm**.

The TOTP secret is generated in your browser and never sent to any server other than to store the encrypted key for verification.

### Day-to-day use

When you perform an admin action, the UI prompts for a 6-digit code. After entering it, the code is cached for 15 minutes so you are not asked again on every click.

### Disabling

Click **Disable MFA**. No code is needed — this is intentional, so you can recover if you lose your authenticator.

---

## Settings — Networks

Networks sync selected spaces between multiple Ythril instances over the internet.

### Network types

| Type | Who approves joins and leaves |
|------|-------------------------------|
| **Closed** | All members must agree unanimously |
| **Democratic** | Majority vote, any member can veto |
| **Club** | The person who invited decides alone |
| **Braintree** | All parent nodes up to the root must agree |
| **Pub/Sub** | No approval — any compatible brain can subscribe |

### Creating a network

Click **+ Create network**. Enter a label, choose a type, enter the space IDs to include, and optionally set a sync schedule (cron expression).

### Inviting another brain

1. Expand the network card and click **Generate invite**.
2. Copy the invite bundle (a JSON blob).
3. Send it to the other admin out-of-band (email, chat, etc.).

The invite expires after 24 hours.

### Joining a network

1. Click **Join an existing network**.
2. Paste the invite bundle.
3. Enter your brain's publicly reachable URL (e.g. `https://brain.example.com`).
4. If any space IDs overlap with existing local spaces, a dialog lets you choose to merge into the existing space or map the remote space to a new local ID.
5. Click **Join network**.

### Sync schedule

Enter a cron expression on the network card (e.g. `*/5 * * * *` for every 5 minutes). Click **Sync now** to trigger an immediate sync without waiting.

### Sync history

Expand a network card and click **Sync History** to see a log of every sync cycle — timestamp, status, items pulled and pushed, and any errors.

### Voting

When a vote is open (e.g. a member wants to leave), expand the network card and scroll to **Open votes**. Click **✓ Yes** or **✗ No** to cast your vote.

### Leaving a network

Click **Leave network** at the bottom of the network card. Your local data in the network's spaces is kept.

---

## Settings — Storage

**Settings → Storage** shows how much disk space each space is using and the configured quota limits.

When a space approaches its quota limit, writes will first return warnings and eventually be rejected. Contact your administrator to raise the quota.

---

## Settings — Data

**Settings → Data** (admin only) gives you control over the underlying MongoDB database: maintenance mode, manual backups, point-in-time restore, and — when enabled by the infrastructure administrator — live database migration.

### MongoDB connection

The **Database** card shows which MongoDB server this instance is connected to. The **source badge** indicates how the connection was configured:

| Badge | Meaning |
|---|---|
| **default** | Using the bundled `ythril-mongo` container. No custom connection has been configured. |
| **config file** | Connection string is stored in `config.json`, either saved here via migration or set manually. |
| **env var** | Connection is managed by the infrastructure via the `MONGO_URI` environment variable. The variable always takes precedence over `config.json`. |

### Maintenance mode

Maintenance mode suspends all write operations across the entire instance. All write requests return `503 Service Unavailable` while active. Read operations continue normally.

Use it before a restore or any manual database operation where you want to prevent concurrent writes.

Toggle the **Maintenance mode** button to enable or disable it. A banner appears across the top of the UI on all pages while maintenance is active.

### Backups

Click **Run backup now** to trigger an immediate point-in-time dump of the entire MongoDB database. The backup is stored inside the instance's data directory (`<data-root>/backups/<timestamp>/`). Each backup contains a `manifest.json` with metadata and one NDJSON file per collection.

The **Backups** table lists all available backups with their timestamp and the collections they contain.

### Scheduled and offsite backups

> **This feature must be explicitly enabled by your infrastructure administrator** (`YTHRIL_DB_MIGRATION_ENABLED=true`). It is disabled by default.

Automatic and offsite backups are configured via a dedicated `backup.json` file placed alongside `config.json` (typically `/config/backup.json`). This file is **never written by the API** — only the infrastructure administrator can create or modify it via direct filesystem access. This design prevents a compromised admin token from redirecting backups to an attacker-controlled location.

**Example `backup.json`:**

```json
{
  "schedule": "0 2 * * *",
  "retention": {
    "keepLocal": 7
  },
  "offsite": {
    "destPath": "/mnt/offsite-backup/ythril",
    "retention": {
      "keepCount": 14
    }
  }
}
```

| Field | Description |
|---|---|
| `schedule` | Cron expression for automatic backups (e.g. `"0 2 * * *"` = daily at 02:00). |
| `retention.keepLocal` | Maximum number of local backups to retain. Oldest are deleted automatically after each run. |
| `offsite.destPath` | **Absolute path** on the container filesystem to copy each backup to. Mount external drives, NFS shares, or any storage as a Docker/K8s volume pointing here. |
| `offsite.retention.keepCount` | Maximum number of offsite backup sets to retain (default: 14). |

Each backup set at the offsite destination contains:
- `<backupId>/` — MongoDB NDJSON dump (same format as local backups)
- `<backupId>-files/` — copy of `<data-root>/files/` (user-uploaded files), if present

The `backup.json` file must not exist (or can be empty) to disable the feature entirely. All fields are optional.

### Restore

To restore a backup, click **Restore** on any backup row. The instance will:
1. Enter maintenance mode automatically.
2. Replace all data in MongoDB with the backup snapshot.
3. Exit maintenance mode.

Restore is irreversible — all data written after the backup timestamp will be lost. You will be asked to confirm before the operation begins.

### Database migration

> **This feature must be explicitly enabled by your infrastructure administrator** (`YTHRIL_DB_MIGRATION_ENABLED=true`). It is disabled by default on all instances.

> **Not available when `MONGO_URI` is set.** If the connection is managed via environment variable, the **Migrate Database** card shows an informational message instead of the migration form. To change the database in that case, update `MONGO_URI` in your deployment configuration and restart.

Database migration moves the entire database to a different MongoDB server — for example, from the bundled container to Atlas, or between clusters.

Enter the target MongoDB URI and click **Test Connection** to verify reachability before committing. Once you click **Migrate**:
1. Maintenance mode is activated.
2. The current database is dumped to `<data-root>/migration-backup/`.
3. A migration marker is written and the new URI is saved to `config.json`.
4. The server process exits. When Docker or Kubernetes restarts the container, the server detects the marker and restores the dump into the new MongoDB before starting normally.

Migration is a one-way operation. Keep your old database available until you have confirmed the migrated instance is healthy.

---

## Settings — Audit Log

**Settings → Audit Log** (admin only) shows a searchable log of every API operation on this instance.

**Filtering:** Filter by date range, operation type, space, HTTP status, or client IP.

**Table:** Each row shows the timestamp, which token or user made the request, the operation, the space, the HTTP status, and the response time. Click a row to see the full details.

**Exporting:** Download the current filtered view as JSON or CSV.

---

## Settings — Webhooks

**Settings → Webhooks** (admin only) lets you send HTTP notifications to external systems whenever data changes.

### Creating a webhook

Click **+ New Webhook**. Enter:
- **URL** — the HTTPS endpoint to notify.
- **Secret** — used to sign payloads so your endpoint can verify they came from Ythril.
- Optionally restrict to specific spaces and event types.

### Event types

Webhooks fire on any write event: `memory.created`, `entity.updated`, `file.deleted`, etc. — across all five data types (memory, entity, edge, chrono, file).

### Testing

Click **Test** on a webhook card to send a test ping and verify the endpoint is reachable.

---

## Settings — About

The About page shows instance information: label, version, uptime, database version, disk usage, and the last 200 lines of the server log (auto-refreshed every 15 seconds).

---

## Connecting an AI assistant (MCP)

Ythril speaks the Model Context Protocol (MCP), which lets AI assistants like Claude, Cursor, or Windsurf read and write to your knowledge base using natural language.

### Setup

Add the following to your MCP client's config file:

```json
{
  "mcpServers": {
    "ythril": {
      "url": "http://localhost:3200/mcp",
      "headers": {
        "Authorization": "Bearer ythril_yourTokenHere"
      }
    }
  }
}
```

Replace `localhost:3200` with your instance URL and `ythril_yourTokenHere` with a valid token.

One connection entry is all you need — every space the token can access is available. The AI will see instructions listing the available spaces when it connects.

### What the AI can do

Once connected, your AI assistant can:

- **Remember** things — store facts, notes, decisions, and links to entities.
- **Recall** — semantically search everything you have stored.
- **Manage entities** — create, update, merge, and traverse the knowledge graph.
- **Track time** — create and update events, deadlines, plans, and milestones in the chrono log.
- **Work with files** — read, write, list, and move files in any accessible space.
- **Query directly** — run structured MongoDB-style queries against any collection.

Use a **read-only token** to give an assistant search access without the ability to write or delete anything.

Use a **space-scoped token** to restrict the assistant to specific spaces only.
