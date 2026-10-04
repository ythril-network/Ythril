# About, Theme & Embedded Mode

> Part of the [Ythril Integration Guide](../integration-guide.md).

## About API

Base path: `/api/about` — requires a valid Bearer token.

### Instance Info

```http
GET /api/about
Authorization: Bearer <token>   # any valid token
```

**Response** `200`:

```json
{
  "instanceId": "a1b2c3d4-...",
  "instanceLabel": "My Brain",
  "version": "1.0.0",
  "uptime": "3d 14h 22m",
  "mongoVersion": "7.0.15",
  "diskInfo": { "total": 107374182400, "used": 53687091200, "available": 53687091200 }
}
```

### Server Logs

```http
GET /api/about/logs?lines=200
Authorization: Bearer <admin-token>   # admin required
```

Returns recent log lines from the in-memory ring buffer. **Requires an admin token** — logs may contain space IDs, peer URLs, and internal error details.

**Every log line is one line, and bounded.** A value the server did not choose — a peer's document id, label or
round id, a caller's parameter, a database driver's error text — is written escaped (a line break reads as `\r\n`,
any other control character as `\u001b`), with credentials redacted, and cut at **4096** characters per value with
`…(+N chars)` saying how much was left out; a list of such values shows at most 100 of them and then `…(+K more)`.
So a peer cannot start a line of its own, and a megabyte `_id` or `seq` makes a line, not a megabyte of one. The same
bound applies where such a value is named back in an answer: a sync refusal's reason, the fork-limit `400`, and an
admin import's `refused`, `schemaViolations` and `restoredOverTombstone` entries; a write refused for a malformed or
missing reference names its first **5** references, each cut at **256** characters, then `…(+N more)`. An error passed
with its stack keeps the stack (escaped onto the line) with its message bounded.

**Response** `200`:

```json
{
  "lines": [
    "[2026-03-26T08:00:00.000Z] [INFO ] Server started on port 3200",
    "..."
  ]
}
```

| Parameter | Default | Max | Description |
|-----------|---------|-----|-------------|
| `lines` | 200 | 1000 | Number of recent log lines (from in-memory ring buffer) |

---

### Server Log Stream (SSE)

```http
GET /api/about/logs/stream
Authorization: Bearer <admin-token>
Accept: text/event-stream
```

Real-time stream of log lines as Server-Sent Events.

- Admin token required
- Sends heartbeat comments periodically to keep the connection alive
- Each event payload is a single escaped log line (`data: ...`)
- **Browser clients** (which can't set headers on `EventSource`) authenticate with a single-use ticket:
  `POST /api/about/logs/ticket` with the `Authorization` header returns `{ ticket, expiresInMs }`; open the
  stream with `?ticket=<ticket>`. A raw `?token=` in the URL is rejected (it would leak into logs/history).

Close the HTTP connection to stop streaming.

---

## Theme API

Base path: `/api/theme` — unauthenticated (public).

The theme endpoint supports portal-style embedding where an outer shell injects branding into Ythril.

### Get Theme

```http
GET /api/theme
```

**Response** `200`:

```json
{ "cssUrl": null }
```

Or, when a theme is configured:

```json
{ "cssUrl": "https://cdn.example.com/brand.css" }
```

### Configuration

Add a `theme` block to `config.json`:

```json
{
  "theme": {
    "cssUrl": "https://cdn.example.com/brand.css"
  }
}
```

The `cssUrl` must be a valid HTTPS URL (HTTP is allowed only for `localhost` during development). The URL is validated at runtime — invalid or non-HTTPS URLs are silently rejected.

### How It Works

1. **Static CSS** — on startup, the Angular SPA fetches `/api/theme`. If `cssUrl` is non-null, a `<link rel="stylesheet">` is injected into `<head>` before the app renders.
2. **Runtime tokens via `postMessage`** — the embedding page can send CSS custom property overrides to the Ythril iframe:

```js
// DERIVE the target origin from the iframe you already have. Do not build it from your own
// hostname — see the warning below.
const ythrilOrigin = new URL(iframe.src).origin;

iframe.contentWindow.postMessage({
  type: 'ythril:theme',
  tokens: {
    '--primary': '#0066cc',
    '--background': '#f5f5f5'
  }
}, ythrilOrigin);
```

Only `--`-prefixed CSS custom properties are accepted. Standard CSS properties (e.g. `color`, `background`) are silently filtered out to prevent injection.

> **The `targetOrigin` must be Ythril's origin, and the safest way to get it is from `iframe.src`.**
> An earlier version of this snippet ended `}, 'https://your-ythril-host');` — a placeholder, which reads as
> an invitation to construct the value. An operator reported this in the console on 2026-08-20, embedding
> Ythril in a page on `www.example.com`:
>
> ```text
> "postMessage" could not be executed on 'DOMWindow': the specified target origin
> ("https://ythril.www.example.com") does not match the recipient window's origin
> ("https://www.example.com").
> ```
>
> `ythril.www.example.com` is not a host anybody has. It is `"ythril." + location.hostname` — the shape you
> get from assuming Ythril lives at a `ythril.` subdomain of the embedding page's domain, which is true right
> up until the embedding page is on `www`. **Every one of those messages is refused by the browser**, so the
> theme silently never arrives and nothing in Ythril reports a problem, because nothing in Ythril was reached.
>
> Two further notes on that error, because it is easy to misread:
>
> - **It is thrown in the EMBEDDER's page, by the embedder's own call.** Ythril's bundle contains exactly one
>   window-targeted `postMessage`, in the OIDC silent-refresh callback, and it targets `location.origin`. If
>   you see this error, the sender is your page.
> - **The "recipient window's origin" it names is the PARENT's, not the frame's**, which makes the message
>   look as though it is complaining about the wrong window. It is not: `postMessage` compares your stated
>   target against the origin of the window you called it on, and calling it on `iframe.contentWindow` before
>   the frame has navigated gives you a window still at the parent's origin. So this error can ALSO mean the
>   frame had not loaded yet — wait for the iframe's `load` event before posting.
>
> **And `load` is necessary but not sufficient.** The SPA registers its `message` listener after its own
> `/api/theme` fetch settles, so a token pushed in the same tick as `load` can arrive before anything is
> listening and is simply lost — there is no queue and no error. `postMessage` is the RUNTIME-UPDATE path;
> for the first paint use `cssUrl` on `/api/theme`, which the SPA fetches itself and applies before
> rendering. If you must push the initial tokens this way, send them again a moment later rather than
> assuming the first one landed.

The `postMessage` handler validates `event.origin`. **Same-origin messages are always accepted. A cross-origin embedder — which is what portal-style embedding actually is — is accepted only if the operator has explicitly allowlisted its origin** (see below). Without that opt-in, a cross-origin `postMessage` is ignored *and* the browser will refuse to frame Ythril at all.

### What a theme owns — and what it must not touch

**A theme owns identity. It does not own facts.**

Both paths above can set any `--` custom property, so both can reach tokens that are not brand colours. One class
of token reports **what the system is**, and recolouring it makes the product lie:

| do not override | it means |
|---|---|
| `--state-active` | a feature is configured and running — "Active", "Online", "In use" |
| `--success` | a check passed — "Healthy", "Reachable", "Complete" |
| `--warning` | degraded, still working — a fallback is in use |
| `--error` | failed |
| `--info` | in progress, nothing wrong |
| `--status-*-bg` / `--status-*-fg`, `--success-*`, `--warning-*`, `--error-*` | derived from the five above |

This is not a style preference. A brand palette built on red made **"Active" and "Online" render red** while
"Healthy" and "Reachable" stayed green — the same instance reporting the same good news in two colours, one of which
reads as an alarm. Fixed in the code for the tokens that were mixing the two, but a theme can still override these
directly, and nothing in the browser can stop it.

**Brand tokens are yours**: `--accent`, `--accent-hover`, `--accent-text`, `--nav-active`, the backgrounds, the text
greys, the borders, the radii. Anything that says *"you are here"* — a selected tab, a highlighted row, a sort caret
— is navigation and correctly follows `--accent`.

One caveat if you do restyle the text greys: they are chosen to clear **WCAG AA (4.5:1)** against all three
background tokens, and that is computed on every build (`text-contrast-meets-aa`). A theme is outside that check.

### Decoration inks: making our surfaces sit in your page (3.2.0)

A theme recolours our tokens. **Decoration inks are different** — they are your own properties, under your own
names, which our card surfaces read if you supply them. Set `--tr-hot` and Ythril's cards, modals and dialogs
become translucent with a lit top edge and a soft cast shadow, so your backdrop shows through instead of our
opaque surface hiding it.

| property | used for |
|---|---|
| `--tr-hot` | **the signal.** Its presence is what turns decoration on; also the lit hairline along each surface's top edge |
| `--tr-mid` | the hairline outline. Falls back to our own `--border` if unset |

**Absence is the signal, and that is the whole contract.** No `--tr-hot` means every surface renders exactly as it
does on a standalone instance — not "equivalently", but with none of these declarations present at all. A
declared-but-empty value counts as absent, because your orchestrator cannot distinguish *"left blank"* from
*"wants blank"*.

Resolved once, before the app boots, so the first paint is already right. Changing the ink after load needs a
reload — this is a property of your served stylesheet, not a runtime channel, and it deliberately does not use
`postMessage`: the values are already in our document.

**Why we read yours rather than you styling ours:** a parent stylesheet does not cross an iframe boundary, and our
document paints its own background over anything behind the frame. Raising a layer in front of the frame puts
traces over text somebody is reading. Reading the inks from inside is the only version that works.

The treatment is deliberately restrained — a translucent fill, one hairline, one outline, one shadow — because
texture over text costs legibility and every layer is another composite.

### Enabling cross-origin embedding (opt-in)

By default Ythril may only be framed and themed by its own origin. There are two ways to list a **different** origin, and they enforce the same rule.

#### From the admin UI — Settings → Embedding

An instance admin can manage the list at **Settings → Embedding** without shell access. This is the route to point an operator at when the brain is theirs and the portal is yours: added 3.2.0, after the canary operator reported that talking somebody through editing JSON on their own server means, in practice, that it does not happen.

| | admin UI | `config.json` |
|---|---|---|
| who can | a token with `instanceAdmin`, plus MFA | anyone with shell access to the host |
| an invalid entry | **refused, and named back to you** | dropped, with a warning in the log |
| takes effect | next request | next request |
| API | `GET`/`PATCH /api/admin/embed-config` | — |

The difference in the middle row is the important one. A form has somebody waiting on an answer, so an origin it cannot accept comes back as a `400` naming it; a config file has nobody to tell, so a bad entry is skipped rather than failing the whole boot. Both call the same validator, so what is *accepted* never differs.

`GET /api/admin/embed-config` also reports `invalid` — the stored entries the validator drops. If a portal will not frame and the list looks right, that field is where the answer is.

#### From `config.json`

Equivalent, and still the right choice for a provisioned or infra-managed deployment:

```json
{
  "embed": {
    "allowedOrigins": ["https://portal.example.com"]
  }
}
```

A listed origin is granted **both** rights together, because they are the same trust decision:

1. it may **iframe** Ythril — the origin is added to the CSP `frame-ancestors` directive; and
2. it may **push theme tokens** via `ythril:theme` `postMessage`.

**You are accepting responsibility for every origin you list.** Framing a page is a clickjacking primitive, and restyling it can be used to spoof the UI — only list hosts you control. Entries are validated strictly and fail closed:

- exact, scheme-qualified origins only — `https://portal.example.com`, never a path/query/fragment
- `https:` required (except `http://localhost` / `http://127.0.0.1` for development)
- **wildcards (`*`) are never accepted** — there is no "allow everything" mode
- an invalid entry is dropped with a warning rather than coerced

The resolved allowlist is logged at startup, and is served to the SPA on `/api/theme` as `allowedOrigins` so the client knows which senders to trust.

**`GET /api/theme` is public, and that is contract rather than an accident.** It is how an embedder can ask *may I frame this instance* before trying — a refused cross-origin frame is undetectable from the embedding side, because the browser reports nothing, so without something the brain volunteers about itself the only safe default is a new tab for everybody. Depend on it; a change to its shape would go through a deprecation with a version's notice.

**No restart is required, by either route.** `config.json` is watched and a foreign edit goes through the full reload path; the CSP `frame-ancestors` directive is rebuilt on every response; `/api/theme` resolves the list per request. An edit is live within about two seconds, and a UI save is live on the next request.

### Security

- `cssUrl` is restricted to HTTPS (except `localhost` for development).
- `postMessage` origin must be `self` **or** an operator-allowlisted origin.
- Only CSS custom properties (`--*`) are applied from runtime tokens.
- `Content-Security-Policy: frame-ancestors 'self' <allowlisted origins…>; object-src 'none'; base-uri 'self'; font-src 'self'` — with no allowlist `frame-ancestors` is `'self'` only, blocking cross-origin embedding, plugin injection and base-tag hijacking; `font-src 'self'` keeps the UI's typeface on the instance rather than a CDN.

---

## Embedded (chrome-less) Mode

When Ythril is embedded in a host portal, its own topbar (logo + **Sign out**) duplicates the host's chrome, and the in-frame Sign out is misleading — it ends only the Ythril session, not the portal's.

Load the app with `?embedded=1` to hide the shell topbar:

```html
<iframe src="https://your-ythril-host/brain?embedded=1"></iframe>
```

Navigation is unaffected — it lives in the sidebar, not the topbar. The flag is read once at startup and persists across in-app navigation (Angular drops unknown query params on route changes, so it is cached rather than re-read). **It also survives a sign-in inside the frame**: the identity provider's callback is a new document without the parameter, so the flag is kept in the tab's `sessionStorage` and read from there. That storage is per tab and per origin, so a direct visit in another tab shows the full shell; `?embedded=0` clears it.

Accepted values: `1`, `true`, `yes`. Anything else (or an absent param) renders the normal shell.

---
