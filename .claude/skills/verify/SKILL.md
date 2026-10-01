---
name: verify
description: Runtime-verify a client or server change by booting an isolated Ythril instance (scratch config + scratch Mongo DB) and driving the Angular UI with Playwright. Use before committing nontrivial client/server changes.
---

# Verifying Ythril changes end-to-end

The user's real instance runs in Docker on port 3210 with real data — never drive it.
Boot an isolated copy instead; it takes ~30 s.

## Isolated server (from source, scratch state)

```powershell
$env:PORT='3260'; $env:TRUST_PROXY='1'                 # TRUST_PROXY=1 or the dev proxy's xfwd header 500s every API call (rate limiter)
$env:CONFIG_PATH='<scratch>\config\config.json'        # nonexistent file → server boots in first-run /setup mode
$env:DATA_ROOT='<scratch>\data'
$env:MONGO_URI='mongodb://127.0.0.1:27017/ythril_scratch'   # host mongod; distinct DB name isolates it. NO vector search — see below
Set-Location server; npx tsx src/index.ts              # run in background, redirect output to a log
```

**From a worktree under `.claude/`, every client route 404s.** Express `sendFile` refuses a path with a dot segment,
so the SPA fallback cannot serve `index.html` out of `.claude\worktrees\<name>\client\dist\browser` — `/setup`
answers 404 while the API works (found by the Q-99 part 2 verify, 2026-10-01). Point `CLIENT_DIST` at a junction
outside the dot path (`New-Item -ItemType Junction -Path <scratch>\client-browser -Target <worktree>\client\dist\browser`)
and remove the junction afterwards.

**Anything that runs `recall` or `similar` needs a search engine, and host mongod has none.** Every recall answers
`SearchNotEnabled` (code 31082) against it — found by the Q-92 verify, 2026-09-28; this line used to say host mongod
"supports $vectorSearch". For those, give the scratch server its own Atlas-local container and remove it afterwards:

```powershell
docker run -d --name ythril-verify-mongo -p 127.0.0.1:27047:27017 mongodb/mongodb-atlas-local:latest
$env:MONGO_URI='mongodb://127.0.0.1:27047/ythril_scratch?directConnection=true'
# ... drive, then:
docker rm -f ythril-verify-mongo
```

**Screenshot the element, not the page.** The app scrolls inside an inner container, so `fullPage: true` captures
only the viewport; use `locator.screenshot()` for anything below the fold, and count elements in the DOM (for
example `.alert-warning`) when the claim is that something appears once.

Seed large records LAST and wait for the embed log to go quiet before driving the UI: local embedding runs on the
server's main thread (Q-99), so ~100 KB of text per record stalls every request, `/login` included, for seconds.

Wait for `http://localhost:3260/health` → 200. To reset to first-run: stop the server,
delete the scratch config files, drop the scratch DB
(`node -e "...MongoClient... db('ythril_scratch').dropDatabase()"` using the repo's mongodb package),
restart. The server caches config in memory — a restart is required.

## Client: prefer the BUILT bundle over `ng serve`

The server already serves the compiled SPA — `express.static(client/dist/browser)` with an index.html
fallback — so `npm run build:client` and then driving **`http://localhost:3260`** needs no second process, no
proxy file, and tests the bundle that actually ships. Rebuild after each client edit (~7 s).

Only reach for the dev server when you need HMR or source maps. `proxy.conf.json` targets 3210, so make a
scratch copy pointing at 3260 (must be UTF-8 **without BOM**; PowerShell 5.1 `-Encoding utf8` writes a BOM
and ng fails with `[1,1] InvalidSymbol`):

```powershell
Set-Location client; npx ng serve --port 4260 --proxy-config <scratch>\proxy.conf.json
```

## Driving the UI (Playwright, no install needed beyond npm)

`npm i playwright` in a scratch dir; launch with `channel: 'msedge'` (installed on this machine — no browser download).

Flow and selectors that work (verified 2026-08-01 against the built bundle on :3260):
- Served from the bundle, the **server itself** redirects `/` → `/setup` on a first run. There is no `/login`
  hop to click through, so wait for `/(setup|login)` and branch.
- Setup takes **three fields and the submit button has no id** (corrected 2026-08-19 against the built bundle
  on :3260): `#label`, `#pw`, `#pw2`, then `button[type=submit]` (its text is "Complete setup"). This line said
  *"label-only: `#label` then `#submitBtn`. There are no `#pw`/`#pw2` fields"* — the form gained a settings
  password since, so `waitForSelector('#submitBtn')` burns its full 30 s and the run dies. Password must be 8+
  chars and `#pw2` must match.
- **Read the new token from the page TEXT, not from `input#token`** (corrected 2026-08-05, against the built
  bundle on :3260). After submit the page has **no inputs at all**, so `waitForSelector('input#token')` burns
  its full timeout and the run dies having already consumed the one-time token — the next attempt then lands
  on `/login` with no way in. Match `/ythril_[A-Za-z0-9_-]+/` against `page.textContent('body')`, and **write
  it to a file immediately**.
- **POLL for that token; do not sleep a fixed interval and read once** (2026-08-19). A single read after 4 s
  caught the page still showing "Setting up…" and threw — while the server log already said `Setup complete`,
  so the one-time token was gone and recovery meant a full reset. Loop `waitForTimeout(500)` up to ~20 s until
  the regex matches. A poll cannot lose the token; a fixed wait can, and did.
- If you do lose it: stop the server, delete the scratch config, drop the scratch DB, restart — that is the
  only way back to `/setup`.
  Behind the dev proxy the older flow (`.code-block span`, "Continue to sign in") may still apply.
- Login: `#token` + submit; bad token → "Invalid or expired token.".
- **`/files` redirects to `/brain`.** The file manager is a Brain **tab** ("Files", with a count badge), not
  its own route. Its upload `<input type=file>` is `hidden` inside a label — `setInputFiles` works on it, but
  only once the tab is open.
- Spaces/Tokens create flows are dialogs: "Create New Space" / "Create Token" buttons open them; submit with
  `getByRole('button', {name: 'Create', exact: true})` — `has-text` is case-insensitive and matches the opener button too.
- Brain tabs (Query, Graph, Files, Entities, Edges, Memories, Chrono, File Meta) carry count badges —
  match with non-exact `getByText(tab).first()`.
- Entity add-form's NAME field is the only visible input without a placeholder: `input:not([placeholder]):visible`.
- Strong CD probes: language switch on `/settings/preferences` (`.lang-btn` "Deutsch" → nav shows "Abmelden"),
  token create → success panel → list update, entity create → tab badge increments.

Routes to sweep: `/brain`, `/files/conflicts`, `/schema-library`, `/settings/{tokens,spaces,storage,networks,preferences,audit-log,data,about,models,duplicates}`.

## Gotchas

- Setup auto-creates a "General" space.
- Collect page console errors; filter for `NG0`/zone patterns after change-detection work.
- One benign 500 ("Config not loaded") is logged during first-run before setup completes — pre-existing server behavior, not a client bug.
- On plain host mongod the server logs "Could not list search indexes" warnings — harmless in scratch runs.
- **From a git worktree under `.claude/`, the server will not serve the SPA** (found 2026-09-30, bundle-32). Express's
  `static` and `sendFile` refuse any path with a dot-folder in it, so every page answers `{"error":"Not found"}`
  and the setup page never appears (Playwright times out waiting for `#label`). Copy the built bundle to a path
  with no dot-folder and point `CLIENT_DIST` at it — copy again after every client rebuild:
  ```bash
  cp -r client/dist/browser <scratch>/dist-copy
  CLIENT_DIST='<scratch>/dist-copy' PORT=3260 TRUST_PROXY=1 CONFIG_PATH='<scratch>/config/config.json' \
    DATA_ROOT='<scratch>/data' MONGO_URI='mongodb://127.0.0.1:27047/ythril_scratch?directConnection=true' \
    npx tsx src/index.ts   # from server/
  ```
- **The app has ONE theme.** There is no light/dark switch and no `prefers-color-scheme` rule in `styles.scss`, so a
  "both themes" check does not apply — screenshot the one theme and say so rather than emulating a scheme the CSS
  ignores.
