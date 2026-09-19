# Connecting an AI Assistant (MCP)

> Part of the [Ythril User Guide](../userguide.md).

## Connecting an AI Assistant (MCP)

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

**If that config file lives inside a git repository, do not paste the token into it.** Most clients expand
`${VAR}` inside the `headers` block, so keep the reference in the shared file and the value in a per-workspace
one that is ignored:

```json
{
  "mcpServers": {
    "ythril": {
      "type": "http",
      "url": "https://your-instance.example/mcp",
      "headers": { "Authorization": "Bearer ${YTHRIL_MCP_TOKEN}" }
    }
  }
}
```

`YTHRIL_MCP_TOKEN` here is **your MCP client's** variable, not a Ythril setting — the client expands it when
it builds the header, and the server never sees the name. Set it wherever that client keeps per-workspace
values (for Claude Code, the `env` block of `.claude/settings.local.json`), and use a **distinct name per
instance** if one window talks to two Ythril instances. Your editor may flag `${YTHRIL_MCP_TOKEN}` as unknown;
that warning comes from the editor's own variable resolver, not from the MCP client.

### Several clients on one machine: one scoped token each

This section is written from a real failure on a live instance, contributed by an operator who hit it. If you
run more than one assistant window — one per project, say — read it before you rely on OAuth.

**What goes wrong.** Three editor windows each pointed at the same `https://…/mcp` URL with no auth header,
relying on interactive OAuth. Authenticating two of them collapsed the third to a single space: fourteen
spaces began refusing with *"token does not have access to space 'X'"*. Two causes, and the second is the one
that matters:

1. **The OAuth grant is keyed by server URL, not by workspace.** The same URL from three project folders is
   one credential slot, and the last authentication wins. The server *definition* is per-workspace; the
   credential is not.
2. **Interactive OAuth takes its identity from whoever completes the browser flow.** There is one human, so
   all three windows authenticate *as that person*, carrying that person's roles. Per-window rights cannot be
   expressed this way at all, however the token is stored — and every write lands under the same subject, so
   the audit log cannot tell the human from an assistant acting on their behalf.

**That failure was the lucky direction.** Everybody lost access, loudly. The same collision resolving the
other way — the widest-scoped window authenticating last — silently grants every other window that scope,
with no error and nothing to notice.

**The fix: mint one API token per client window,** scoped to exactly the spaces that window needs, and send it
as a static `Authorization` header as shown above. An explicit header means the client never enters the OAuth
flow, so it cannot be overwritten by a later authentication against the same URL. It is also the correct
reading of per-caller attribution: one token per caller *is* each caller authenticating as itself. Do not
grant admin unless the window genuinely administers the instance — an assistant has no use for `delete_space_data`.

**Verify by reading the token's own view, not by the absence of an error.** Call the **`help`** tool: it
prints the spaces accessible to this token, and when the token is restricted it says so explicitly
(*"some tools are hidden from this token by its scope"*) — the tools that configure a space, such as
`delete_space_data` and `update_space`, disappear from the list unless the token carries the **Space admin**
grant for a space. (Space admin is its own switch on the token, not something you get by setting all four
area rungs to admin.) A cross-space `recall` will **not** reveal a collapsed scope: it
happily returns results from the one space still reachable, which reads like a successful search.

**Attribution, once you are on per-caller tokens.** Every audited request records `tokenId`, `tokenLabel` and
`authMethod` (`pat` or `oidc`), over both the REST API and MCP, and the log view shows the token label. The
`oidcSubject` field is populated only for OAuth sessions — for an API token it is `null` by design, and it is
not the field that identifies the caller. Filter the audit log by `?tokenId=…` to see exactly what one window
did. See [Settings — Audit Log](05-storage-data-and-audit.md#settings--audit-log).

#### Two traps

**An ignore rule that does not travel is not protection.** `git check-ignore` reports success whether the
matching rule is in the repository's own `.gitignore`, in `.git/info/exclude`, or in a machine-wide
`core.excludesFile` — and only the first is committed. The other two protect exactly one working copy and no
clone, which on a public repository is the difference between a private mistake and a disclosure. Check with:

```bash
git -c core.excludesFile=/dev/null check-ignore -v .mcp.json
```

If that prints nothing, or names a source under `.git/`, the protection is not in the repository. Add the rule
to the committed `.gitignore`.

**There may be a second MCP client you are not thinking about.** VS Code ships its own MCP host with its own
registry (`.vscode/mcp.json`, plus a user-level `mcp.json` that applies to every window) and its own
credential store — a second, invisible route to the same collision, and its auto-discovery can pull in server
definitions written for other tools. If you want MCP from one client only, turn the other off outright
(`chat.mcp.enabled: false` and `chat.mcp.discovery.enabled: false`).

One connection entry is all you need — every space the token can access is available. On connect, the AI receives instructions naming the spaces it can reach and is told to call **`list_spaces`** (and `space_meta`) to learn the schema, purpose, and record counts of each — so it can orient itself before reading or writing. It can also call the **`help`** tool for a guided overview of the whole system (the knowledge model, when to use `query` vs. `recall`, and the tools available to its token).

### Browser connectors (OAuth)

Static-token clients like Claude Desktop, Cursor, and VS Code just send the `Authorization: Bearer ythril_…` header shown above. Browser-based connectors that use the claude.ai-style OAuth flow instead — connect Ythril's `/mcp` URL and you'll be sent through an OAuth **consent** screen where you paste a valid Ythril token to approve. On approval Ythril mints a fresh PAT with the same privileges as the approving token; it appears under **Settings → Tokens** named **`MCP connector: <client>`**. This flow requires the instance to know its own public HTTPS URL (`publicUrl` / `PUBLIC_BASE_URL`).

### Example: connect Ythril to Claude

Claude's web app (and Claude Code on the web) can add Ythril as a **custom connector** over MCP. A full walkthrough:

1. **Give your instance a public HTTPS address.** Claude's web app runs in the cloud, so it cannot reach `localhost` or a private IP — it needs a public URL over HTTPS with a valid certificate. The simplest route is Ythril's built-in **Settings → Networks → local connector** (a Cloudflare tunnel), which publishes your instance at a `https://…` address. Make sure the instance's **public URL** is set (so the OAuth details it generates point at the right host).
2. **Create a scoped token first** (**Settings → Tokens**). The connector inherits *exactly* this token's permissions, so decide up front: read-only vs. read-write, admin or not, and which spaces. For example, a **read-only token scoped to a single space** gives Claude search access to just that space and nothing else. Name it something recognisable like `Claude web — read-only`.
3. **Add the connector in Claude.** Open **claude.ai → Settings → Connectors → Add custom connector** and enter your instance's MCP URL: `https://<your-instance>/mcp`. (On Team/Enterprise plans an admin adds it once under **Admin settings → Connectors**; members then authenticate individually.)
4. **Approve the connection.** Claude sends you to Ythril's **consent screen** — paste the token you created in step 2 and approve. Ythril issues the connector a fresh token with the same permissions, which appears under **Settings → Tokens** as `MCP connector: <client>` (so you can see and revoke it at any time).
5. **Enable it in a conversation.** Turn the connector on with the **+** in the chat. Claude first calls `list_spaces` and `help` to orient itself, then it can recall, remember, query, and manage your knowledge graph — limited to whatever the token allows (a read-only token, for instance, won't even see the write tools).

**To change what Claude can do,** issue a differently-scoped token (read-only, or a different set of spaces) and reconnect. **To cut it off,** revoke its `MCP connector` token under **Settings → Tokens**. If you'd rather skip the OAuth flow entirely, connectors that accept custom headers can instead send an `Authorization: Bearer ythril_…` header directly — same scoping (the header token's permissions), no consent step.

### What the AI can do

Once connected, your AI assistant can:

- **Remember** things — store facts, notes, decisions, and links to entities.
- **Recall** — semantically search everything you have stored.
- **Manage entities** — create, update, merge, and traverse the knowledge graph.
- **Track time** — create and update events, deadlines, plans, and milestones in the chrono log.
- **Work with files** — read, write, list, and move files in any accessible space, including pictures
  and PDFs. Roughly 7 MB is the most an assistant can save in one go; anything larger has to be uploaded
  through the Files page or the upload API instead.
- **Query directly** — run structured MongoDB-style queries against any collection.

Use a **read-only token** to give an assistant search access without the ability to write or delete anything.

Use a **space-scoped token** to restrict the assistant to specific spaces only.
