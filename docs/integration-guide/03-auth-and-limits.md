# Authentication, Errors & Rate Limits

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Authentication

Every API request requires a Bearer token, except a handful of public routes: `/health`, `/ready`, `/api/theme`, `/api/setup/status`, `/setup`, `/api/invite/apply`, and `/api/auth/oidc-info`:

```http
Authorization: Bearer ythril_<base62-encoded-token>
```

Tokens are created during first-run setup or via `POST /api/tokens`. The plaintext token is shown **once** — store it securely.

**A token may instead be minted with a `rights` matrix** — per-space, per-area levels (`none` / `read` /
`write` / `admin`) plus a `floor` that applies to every space including ones created later. Two rules:

- **`rights` and `spaces`/`admin`/`readOnly` cannot be sent together** — `400`. A body carrying both
  describes the same access twice, and whichever lost would be applied silently.
- **A token can never mint above itself** — `403`, naming every level that exceeded the minter. This is
  enforced on the endpoint, not only in the UI, so it holds for the API too.

**The space allowlist field is `spaces`, and nothing else.** The body is strict: any key it does not declare
is a `400` naming it. This used to be a silent drop — `spaceIds`, `allowedSpaces`, `scope` and `denySpaces`
were all accepted with a `201` and thrown away, so a token minted with one of those names had **instance-wide
access while appearing scoped**. If you have tokens minted with a field other than `spaces`, re-check them:
they are not scoped.

> **The token must travel in the header.** A `?token=…` query parameter is ignored on every route → `401`, with **no exception**. Query strings end up in access logs, proxy logs, browser history, and `Referer` headers, so a long-lived token must never ride in a URL. The last exception was `GET /mcp`, the MCP SSE transport, whose clients might not have been able to set a header — 4.0 removed that transport and the fallback with it. The **browser** SSE streams — `GET /api/brain/spaces/:id/events` and `GET /api/about/logs/stream` — use a **single-use ticket**: `POST` the paired `…/ticket` endpoint with the normal `Authorization` header to get a short-lived opaque ticket, then open the stream with `?ticket=<ticket>` (see the live-events section below).

### Token Scoping

| Token Type | Access |
|---|---|
| Full-access | All spaces, read + write |
| Space-scoped | Only endpoints for listed spaces; admin routes blocked |
| Read-only | Read/search only — all mutations (create, update, delete) blocked |
| Admin | Full-access + admin-only routes (networks, tokens, config) |

> A token **cannot** be both `admin` and `readOnly`.

### Auth Middleware Levels

| Middleware | Required |
|---|---|
| `requireAuth` | Any valid token |
| `requireAdmin` | Token with `admin: true` |
| `requireAdminMfa` | Admin token + MFA verified (if MFA enabled) |
| `requireSpaceAuth` | Token with access to the `:spaceId` in the URL |
| `denyReadOnly` | Applied on mutating routes — blocks `readOnly` tokens |

---

## Error Format

**Every JSON API route** — everything under `/api/` — answers an error with:

```json
{ "error": "Human-readable message" }
```

That holds for handler errors, validation failures, the `404` on an unknown `/api/` path, all rate
limiters, and anything unhandled (which returns a generic message rather than the internal one).

**Two surfaces deliberately answer in another format, because their consumer does not parse JSON.** Both are
listed here rather than left for you to discover from a parse failure:

| surface | error format | why |
|---|---|---|
| `GET /metrics` | Prometheus comment lines (`# Unauthorized: …`) | A scraper does not parse JSON, and `#` is a comment in the exposition format, so the error degrades into something readable rather than corrupting the parse. |
| the first-run `/setup` flow | text or HTML | Setup is server-rendered and exists *before* the SPA does; its consumer is a browser, which would render a JSON body as raw text. |

So: **do not treat a non-JSON error body as a bug**, and do not code against "all errors are JSON" — code
against "every `/api/` error is JSON". A gate holds that boundary and requires a written reason before
anything is added to the exception list.

Extended errors may include:

```json
{ "error": "Storage limit exceeded", "storageExceeded": true }
```

### A failure of the STORE is a 503, and says so in a field

**The brain read routes — `POST …/recall`, `POST …/find-similar` and `POST …/query` — distinguish a failure
of your request from a failure underneath us.** Every failure body from those three carries `retryable`,
true or false, whether or not it bit:

```json
{ "error": "Executor error during aggregate command on namespace: … :: caused by :: the store reported no
           cause (this is a store-side failure, not a problem with your request — it can be retried)",
  "retryable": true, "code": 8, "codeName": "InternalError" }
```

A `503` also carries `Retry-After`. `code` and `codeName` are the store's own, present when it supplied them,
and they are an operator's fastest route to the real condition.

> **Why this exists, because the cost was not the confusing message.** Until this release those routes
> answered **400 for every failure**, including a vector-search stage that had simply stopped answering. A
> `4xx` means *the fault is yours, do not retry* — so a client built correctly around that (`onError:
> continue`, no retry, no alert) ran on with no context and produced plausible, uninformed output. An
> integrator measured it at **one call in six across fourteen agents, silently.** The status was the whole
> defect; the message being truncated was the half an operator saw.

**Read `retryable` rather than matching the prose**, and treat a `503` from these routes as transient: the
conditions behind it (a search index re-initialising after a restart, a replica set stepping down, a search
process that died) clear on their own, in seconds for a blip and in hours for a large reindex.

**We do not retry internally, deliberately.** A transparent retry would turn a dead search process into slow
successes and hide it from the operator who can fix it. You get told, and you decide.

**On MCP the same classification arrives as `structuredContent` with `retryable: true` and
`storeSideFailure: true`**, because that transport answers `200` with `isError: true` and has no status code
to correct. The information is identical; only the envelope differs.

### Common Status Codes

| Code | Meaning |
|---|---|
| 400 | Bad request / validation failure — **your request, and retrying it unchanged will fail identically** |
| 401 | Missing or invalid token |
| 403 | Token lacks access to this resource. **On a search naming spaces, one space you cannot read refuses the whole call** and the message names which — a partial answer would be indistinguishable from a small one. Omit `space` instead and the search silently covers only what you can read. |
| 404 | Resource not found |
| 409 | Conflict (duplicate ID) |
| 413 | Payload too large (Express body limit: 10 MB for JSON) |
| 429 | Rate limited — check `Retry-After` header |
| 503 | **The store could not answer. Not your request — retry it.** See below |
| 507 | Storage quota hard limit exceeded |

---

## Rate Limits

| Scope | Limit | Keyed by | Applies To |
|---|---|---|---|
| Auth | 10 / min | source IP | Token creation, setup, invite/apply |
| Global | 300 / min | client | All authenticated endpoints — the pre-auth backstop |
| Per token | 300 / min by default, **settable** | token id | All authenticated endpoints, once the token is resolved |
| Sync | 2 000 / min | client (peer) | Sync API endpoints |
| Notify | 60 / min | client | `GET /api/notify`, `POST /api/notify`, `POST /api/notify/trigger` |
| Bulk wipe | 5 / min | client | `DELETE /api/brain/spaces/:spaceId/{facts,entities,edges,chrono}` |
| Flood backstop | 3 000 / min | source IP | Everything except `/health`, `/ready`, `/metrics` |

**"Keyed by client" means your budget is your own.** The limiter buckets on the credential you present —
the `Authorization: Bearer` token, or the MCP `?token=` parameter — so one busy integration cannot spend
another's allowance. This matters most in the default Docker deployment: with no reverse proxy in front,
every request reaches Ythril from the same Docker gateway address, so an IP-keyed limit would be a single
shared bucket for the whole instance. The credential is hashed before it is used as a key; it never
appears in a key, a log line, or a header.

Requests with **no** credential (login, setup, an anonymous probe) key on the source IP — that is the only
identity they have — and IPv6 addresses are normalised to their `/64` so a client cannot rotate through
addresses it already owns.

### The per-token quota is settable, and there are two tiers

Added in 3.3.0. The number a token gets is resolved in this order:

1. the token's own `rateLimitPerMinute`, set by an instance admin;
2. `YTHRIL_RATE_LIMIT_PER_MINUTE`, set by whoever runs the instance;
3. **300 / min**, which is what the global limiter has always allowed.

So an instance that configures neither tier behaves exactly as it did before.

**Absent on a token means INHERIT, not unlimited.** Most tokens carry no value at all, and that is the
default state rather than an escape from the limit.

`GET /api/tokens` and the MCP `list_tokens` tool both return two fields, and you almost always want the
second: `rateLimitPerMinute` is what somebody SET, and `rateLimitEffective` is the number actually
enforced. Read the effective one to answer *why is this client getting 429*.

**`YTHRIL_RATE_LIMIT_PER_MINUTE` is a ceiling, not just a default.** When it is set, a per-token value above
it is refused with a **403** naming the ceiling — never accepted and quietly reduced. If you automate token
creation, that 403 means infra owns the number and your request asked for more than it allows.

**The global limiter STEPS ASIDE once you present a credential.** It runs before authentication and cannot
know which token you are — the limit is a property of a record that has not been read yet — so it applies to
requests carrying no credential at all: login, setup, an anonymous probe. Present one and the per-token quota
is the only limit on the request.

That changed in 3.6, and it is a fix rather than a loosening. Before it, the global limiter's fixed 300/min
keyed on a hash of your credential, so it gave every token its own 300 bucket and the real limit was
`min(300, rateLimitPerMinute)`. Setting 1 000 granted nothing while `rateLimitEffective` reported 1 000 —
three different numbers for one quota. **If you set a per-token limit above 300 and saw no change, that is
why.**

Nothing is now unbounded that was bounded before: the global limiter never restrained a flood of INVENTED
credentials either, because it is keyed per credential and each new string minted a fresh bucket. The flood
backstop below is what closes that, and it does not step aside for anything.

The **flood backstop** is a per-IP ceiling in front of every route, set far above any legitimate single
client. It exists because per-client keying alone would let a flood of random bearer strings mint an
unbounded number of buckets. You should never see it in normal operation.

> **Behind a reverse proxy, set `TRUST_PROXY`** (see the environment table above) to the exact number of
> proxy hops. Without it `req.ip` is the proxy's address, so the auth limiter and the flood backstop
> collapse to one bucket for all traffic through that proxy. Do not use `true`: it trusts the entire
> client-supplied `X-Forwarded-For` chain, which lets a caller spoof the address those limits key on.

Rate limit headers follow the IETF draft-7 format: a single combined `RateLimit` header plus a `RateLimit-Policy` header (the legacy draft-6 `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers are not emitted):

```text
RateLimit: limit=300, remaining=297, reset=42
RateLimit-Policy: 300;w=60
Retry-After: 42
```

Every response includes an `X-Request-Id` header (UUID), and **every server log line the request's own work
produces carries the same id** — so a failing call can be quoted by id and its log lines found by grep. Lines
written outside a request (boot, the TTL sweep, the background storage walk) carry no id, which is what stops a
search for a real one from matching them. The one exception is a line logged from an event callback that fires
after the handler returns (a connection close, a child-process error); today those are debug-level only.

---
