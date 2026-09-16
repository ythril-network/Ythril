# Getting Started

> Part of the [Ythril User Guide](../userguide.md).

## Getting Started

## Logging in

Open your instance URL in a browser (e.g. `http://localhost:3200`). Enter your access token — the one you received during setup — and click **Sign in**.

If your organisation uses single sign-on (SSO), you will be redirected to your identity provider automatically. After authenticating there you land back in Ythril already logged in.

To sign in with a token when SSO is active, go to `/login?local`.

**First run:** on a brand-new instance the login page shows a **Run first-time setup** link (`/setup`) that walks you through creating the admin account and your first access token.

Clicking **Sign out** in the topbar clears the session. (In embedded mode — see below — the topbar and its Sign out button are hidden.)

---

## Navigation

The left sidebar is the main navigation. It is divided into two sections:

### Workspace

- **Brain** — store, browse, and search everything you know. Graph and Files are *tabs inside Brain*, not separate pages — there are no `/graph` or `/files` routes (those URLs just redirect to Brain).
- **Schema Library** — reusable data definitions shared across spaces
- **Conflicts** — appears only when file conflicts are waiting to be resolved, with a red count badge showing how many.

### Admin (admin tokens only)

- **Settings** → Tokens, Spaces, Metrics, Networks, Preferences, Logs, Database, Webhooks,
  Media Processing, Embedding, Help, About

  > **Five of these were named by an older label and two were missing.** Storage is now **Metrics**,
  > Audit Log is **Logs**, Data is **Database**, Models is **Media Processing** — and **Webhooks** and
  > **Embedding** were absent from the list entirely. **Duplicates** was listed and is not a sidebar
  > entry: it is a tab inside the Brain, and the old settings URL redirects there. The body text on
  > [Storage, data and audit](05-storage-data-and-audit.md) already used the current names, so this
  > list was the only page still on the old ones.

Most pages carry a small **Help** link in their top-right corner. It opens the guide at the *section*
that documents that page — not the top of it. Pages with no section yet show no link, so an empty-handed
control never pretends to be an answer.

**Settings → Help** is this documentation, readable *inside* the instance. Every guide that ships with
Ythril — this user guide, the integration guide, the use-case examples, **the decisions log**, workstation
mode, network types, the sync protocol, **the UI primitives reference**, dependencies and licences, and
contributing — is bundled with the application and rendered in place. It needs no internet connection, which is the point: the installs that most need the
documentation are often the ones with no route to the outside. Each guide has its own link
(`/settings/help?doc=userguide`), so a page can point at the guide that explains it.

There is no global space selector in the sidebar. Space switching happens per page — the Brain page shows a row of space chips **above the tab strip**, and every tab inside it, the Graph included, follows that choice. Everything you see is scoped to the space you pick there.

> This said the Graph tab has *"its own space picker in the toolbar"*. It does not: that toolbar holds an > entity search, a depth slider, direction pills, a labels toggle, stats, fit and reset. The Graph page > does have space chips of its own, and they are hidden when it is embedded in the Brain — which is the > only way you reach it as a tab.

**Embedded mode:** loading the app with `?embedded=1` on the URL hides the topbar (logo and **Sign out**) so Ythril can sit cleanly inside a host portal's own chrome. Navigation is unaffected — it lives in the sidebar. Trusted host origins that may iframe Ythril and push theme tokens are listed in `embed.allowedOrigins` in the config; empty or absent means same-origin only.

Since 3.2.0 a host page can also go one step further and have Ythril's cards, dialogs and modals pick up its own decoration — translucent surfaces with a lit top edge, so the app looks like part of the page rather than a panel cut into it. It is opt-in from the host's side and invisible otherwise: an instance that is not embedded in such a page renders exactly as before. See [Theme API](../integration-guide/15-about-and-embedding.md#decoration-inks-making-our-surfaces-sit-in-your-page-320).

---

## Spaces — what they are

A **space** is a completely separate container of data — facts, entities, edges, chrono entries, and files. Think of it as a project folder or a context boundary.

The `general` space is created automatically on first run. Admins can create additional spaces in **Settings → Spaces**. Your access token determines which spaces you can see; if a space is not in your token's scope it is invisible to you.

---
