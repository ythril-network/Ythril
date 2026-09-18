# Quotas, Pagination & OIDC

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Storage Quotas

Configured in `config.json` under `storage`:

```json
{
  "storage": {
    "brain": { "softLimitGiB": 50, "hardLimitGiB": 100 },
    "files": { "softLimitGiB": 100, "hardLimitGiB": 200 },
    "total": { "softLimitGiB": 150, "hardLimitGiB": 200 }
  }
}
```

| Condition | Behaviour |
|---|---|
| Below soft limit | Normal operation |
| Above soft limit | Write succeeds, response includes `storageWarning: true` |
| Above hard limit | Write rejected with `507` and `storageExceeded: true` |

### Pinning the limits from the environment

*New in 2.1.*

Every limit can also be set by an environment variable, on the same **env → `config.json` → unset**
precedence as the model settings:

| Field | Env var |
|---|---|
| `storage.total.softLimitGiB` | `STORAGE_TOTAL_SOFT_GIB` |
| `storage.total.hardLimitGiB` | `STORAGE_TOTAL_HARD_GIB` |
| `storage.files.softLimitGiB` | `STORAGE_FILES_SOFT_GIB` |
| `storage.files.hardLimitGiB` | `STORAGE_FILES_HARD_GIB` |
| `storage.brain.softLimitGiB` | `STORAGE_BRAIN_SOFT_GIB` |
| `storage.brain.hardLimitGiB` | `STORAGE_BRAIN_HARD_GIB` |

**This is for multi-tenant hosting.** On a host running several brains, the disk ceiling is the host
operator's call, and it was the only infra-shaped setting with no way to bind it from the Deployment —
`allowPrivateModelEndpoints`, `modelPath` and the model endpoints have all been env-pinnable for exactly
this reason. A pinned field is reported in `lockedByInfra` on `GET /api/spaces` and rendered read-only
with an **env** badge on **Settings → Metrics**.

Each of the six is independent, so `total` can be pinned while the per-area limits stay editable, or the
reverse. A value of `0` is a real limit (refuse everything), not an absent one. A malformed value is
ignored with a warning and the `config.json` value is used — a limit that parsed to `NaN` would compare
false against every usage figure and enforce nothing while looking configured.

---

## Pagination

### Offset Pagination (Brain API)

One read pages a collection, and it takes `limit` and `skip` in its body:

```http
POST /api/brain/filter
Content-Type: application/json

{ "space": "general", "collection": "facts", "limit": 100, "skip": 200 }
```

`limit` defaults to 200 and has no maximum; what bounds an answer is the byte budget, `maxTimeMS`, and a
proxy space's merge ceiling — all three of which say so in the response. The body is strictly allowlisted,
so `offset`, `page`, `per_page`, `pageSize`, `sortBy`, `orderBy`, `order` and `direction` are a `400`
naming the parameter to use instead of being accepted and ignored.

### Cursor Pagination (Sync API)

Sync endpoints return a `nextCursor` for efficient sequential reads:

```http
GET /api/sync/facts?spaceId=general&sinceSeq=0&limit=200
→ { "items": [...], "nextCursor": "eyJzZXEiOjIwMH0" }

GET /api/sync/facts?spaceId=general&cursor=eyJzZXEiOjIwMH0&limit=200
→ { "items": [...], "nextCursor": null }
```

When `nextCursor` is `null`, all data has been consumed.

---

## OIDC (OpenID Connect) Authentication

Ythril supports an optional OIDC provider as an **additional** authentication path alongside PATs. When enabled, browser users can sign in using their corporate identity (Keycloak, Entra ID, Okta, Auth0, …) without a separately managed PAT.

### Configuration

Add an `oidc` block to `config.json`:

```json
{
  "oidc": {
    "enabled": true,
    "issuerUrl": "https://keycloak.example.com/realms/my-realm",
    "clientId": "ythril",
    "audience": "ythril",
    "scopes": ["openid", "profile", "email"],
    "claimMapping": {
      "admin":    { "claim": "realm_access.roles", "value": "ythril-admin" },
      "readOnly": { "claim": "realm_access.roles", "value": "ythril-readonly" },
      "spaces":   { "claim": "ythril_spaces" }
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `enabled` | Yes | Set `true` to activate OIDC. All other fields are ignored when `false`. |
| `issuerUrl` | Yes | IdP realm URL. The well-known discovery document is fetched from `{issuerUrl}/.well-known/openid-configuration`. |
| `clientId` | Yes | OAuth2 client ID registered at the IdP. |
| `audience` | No | Expected `aud` claim. Defaults to `clientId`. |
| `scopes` | No | Scopes to request. Defaults to `["openid", "profile", "email"]`. |
| `allowedAlgorithms` | No | JWS algorithms accepted when verifying ID tokens. Defaults to the asymmetric set `RS256/384/512`, `PS256/384/512`, `ES256/384/512`, `EdDSA`. Use it to **narrow** verification to what your IdP actually signs with (e.g. `["RS256"]`). |
| `claimMapping` | No | Maps IdP claims to Ythril permissions (see below). |
| `enforceForBrowser` | No | When `true`, the browser SPA rejects cached PAT sessions and always forces a fresh OIDC login. PATs continue to work for API / MCP bearer-header requests. Default: `false`. |
| `postLogoutRedirectUri` | No | URI the IdP should redirect to after `end_session`. Passed as `post_logout_redirect_uri`. Defaults to `{origin}/login`. |
| `allowPrivateIssuer` | No | Permit an issuer on a **private address** (`10.x`, `192.168.x`, `172.16–31.x`, IPv6 ULA). Default `false` — public issuers only. Env: `YTHRIL_OIDC_ALLOW_PRIVATE_ISSUER=true`. **An internal IdP needs this or nobody can sign in** — see below. |

### Internal IdPs on a private address

> **If your IdP lives on a private address — Keycloak on `http://keycloak.internal:8080`, Authentik on
> a cluster service, Dex on `10.x` — you must set `oidc.allowPrivateIssuer: true` (or
> `YTHRIL_OIDC_ALLOW_PRIVATE_ISSUER=true`). Without it, discovery is refused and no one can sign in.**

The server makes two outbound calls on the authentication path: the discovery document at
`{issuerUrl}/.well-known/openid-configuration`, and the JWKS at whatever `jwks_uri` that document
names. The second is a URL the server was *told* to fetch, which makes it an SSRF target, so both now
go through the same egress guard as sync peers and model endpoints. The default is public-only.

Turning the flag on does **not** disable the guard:

- Discovery and JWKS still resolve DNS, **pin the resolved IP** for the connection, and re-validate
  every redirect hop — so a hostname that resolves inward, or a redirect that pivots inward, is still
  refused.
- **Loopback, link-local / cloud metadata (IMDS) and the unspecified address stay blocked regardless**,
  including when a hostname resolves to one.
- The allowance is scoped to the **issuer's own address class**: a *public* issuer may never hand back
  a private `jwks_uri`, `authorization_endpoint` or `token_endpoint`, flag or no flag. OIDC Discovery
  §4.3 constrains only the document's `issuer` field, so the endpoints beside it are validated
  separately.

> **An issuer on `127.0.0.1` / `localhost` is not supported, even with the flag on.** In the normal
> Docker deployment the server's loopback is its own container, so an IdP there is unreachable anyway;
> and the browser is sent to the same `authorization_endpoint`, so the browser's loopback would have
> to be the server's for the flow to complete at all. If you are evaluating Ythril on a single machine
> with a local IdP, address it by the host's LAN IP or a hostname (for example
> `http://host.docker.internal:8080` from Compose) rather than `127.0.0.1`, and set
> `allowPrivateIssuer`.

Endpoints on a *different public host* than the issuer are fine and common — Google publishes
`accounts.google.com` with a `jwks_uri` on `www.googleapis.com` and a `token_endpoint` on
`oauth2.googleapis.com`.

At boot, an enabled OIDC config with a private issuer literal and no flag is reported as a **FAIL** in
the security posture (`oidc.issuer`, visible at `GET /api/about/security`), and with
`security.strict` the server refuses to start — rather than letting you find out from a login page
that just says "authentication failed".

### Claim Mapping

`claimMapping` controls how JWT claims are translated to Ythril permissions:

| Key | Description |
|---|---|
| `admin` | When the rule matches, the session has admin access. |
| `readOnly` | When the rule matches, the session has read-only access. |
| `spaces` | The claim value is used as the list of allowed space IDs (must be a JSON string array). |

Each rule has:

- `claim` — dot-notation path inside the JWT payload (e.g. `"realm_access.roles"`).
- `value` (optional) — the claim must equal this value, or be an array containing it. When omitted, the claim simply needs to be truthy.

**Fail-closed defaults.** A validly-signed JWT that matches **neither** the `admin` nor the `readOnly`
rule is accepted but granted **read-only access to no spaces** — grant access explicitly through the
rules above. (Previously such a token received read-write access to *all* spaces.) When a `spaces`
mapping is configured but the claim is missing or not a string array, the allow-list is empty (deny),
never "all spaces". Set `requireMatch: true` in `claimMapping` to reject unmatched tokens outright
with `401` instead of accepting them with no access.

### Bearer Token Dispatch

| Bearer value | Validation path |
|---|---|
| Starts with `ythril_` | PAT — bcrypt verification (unchanged) |
| Anything else | JWT — JWKS signature + `iss`/`aud`/`exp` verification, then claim mapping |

PATs continue to work without any changes when OIDC is enabled.

### OIDC Discovery Endpoint

```http
GET /api/auth/oidc-info
```

Used by the web client login flow to decide whether OIDC is enabled and which issuer/client settings to use.

**When OIDC is disabled:**

```json
{ "enabled": false }
```

**When OIDC is enabled:**

```json
{
  "enabled": true,
  "issuerUrl": "https://keycloak.example.com/realms/my-realm",
  "clientId": "ythril",
  "scopes": ["openid", "profile", "email"],
  "enforceForBrowser": false,
  "postLogoutRedirectUri": "https://brain.example.com/login"
}
```

`enforceForBrowser` is always present (boolean). `postLogoutRedirectUri` is included only when it is configured on the `oidc` block.

### Login Flow (Browser)

When OIDC is enabled, the login page **auto-redirects** to the IdP — no manual click required.

1. User navigates to `/login`. The SPA fetches `/api/auth/oidc-info` and detects OIDC is enabled.
2. Browser fetches the IdP discovery document and redirects to the authorization endpoint.
3. User authenticates at the IdP.
4. IdP redirects back to `/oidc-callback?code=…&state=…`.
5. The Angular app exchanges the authorization code for tokens directly at the IdP token endpoint (PKCE — no client secret in the browser).
6. The resulting access token (JWT) is stored in `localStorage` and used for all subsequent API calls.

To bypass SSO auto-redirect and use a PAT instead, navigate to `/login?local`.

### Keycloak Setup

1. Create a new client in your realm with **Client authentication: OFF** (public client).
2. Set **Valid redirect URIs** to `https://your-ythril-host/oidc-callback`.
3. Add a mapper for `ythril_spaces` (if using space scoping): **User attribute → Token claim** mapping.
4. Set `issuerUrl` to `https://keycloak.host/realms/<realm>`.

The change is picked up automatically within about two seconds; run `POST /api/admin/reload-config` if you want to apply it synchronously.

### Entra ID (Azure AD) Setup

1. In the Azure portal, go to **App registrations → New registration**.
2. Set **Redirect URI** to `https://your-ythril-host/oidc-callback` (type: **SPA**).
3. Under **Authentication**, ensure **Access tokens** and **ID tokens** are checked under Implicit grant and hybrid flows. Leave the **SPA** redirect URI in place — PKCE is used automatically.
4. Note the **Application (client) ID** — this is your `clientId`.
5. The `issuerUrl` is `https://login.microsoftonline.com/<tenant-id>/v2.0`.
6. Set `audience` to the Application (client) ID (Entra sets `aud` to the client ID by default).
7. To map roles, create **App roles** and assign users/groups. Use `claimMapping.admin.claim: "roles"` and `claimMapping.admin.value: "ythril-admin"`.
8. For space scoping, add an optional claim or use directory extensions to emit a `ythril_spaces` claim.

```json
{
  "oidc": {
    "enabled": true,
    "issuerUrl": "https://login.microsoftonline.com/YOUR_TENANT_ID/v2.0",
    "clientId": "YOUR_CLIENT_ID",
    "scopes": ["openid", "profile", "email"],
    "claimMapping": {
      "admin": { "claim": "roles", "value": "ythril-admin" },
      "readOnly": { "claim": "roles", "value": "ythril-readonly" },
      "spaces": { "claim": "ythril_spaces" }
    }
  }
}
```

### Okta Setup

1. In the Okta admin console, go to **Applications → Create App Integration → OIDC → Single-Page Application**.
2. Set **Sign-in redirect URI** to `https://your-ythril-host/oidc-callback`.
3. Under **Assignments**, assign the users or groups who should have access.
4. Note the **Client ID** from the application's General tab.
5. The `issuerUrl` is `https://your-org.okta.com` (or `https://your-org.okta.com/oauth2/default` if using a custom authorization server).
6. To map admin/readOnly, create groups (e.g. `ythril-admin`, `ythril-readonly`) and configure a **Groups claim** in the authorization server: `claim name: groups`, `filter: Matches regex ythril-.*`.

```json
{
  "oidc": {
    "enabled": true,
    "issuerUrl": "https://your-org.okta.com/oauth2/default",
    "clientId": "YOUR_CLIENT_ID",
    "scopes": ["openid", "profile", "email", "groups"],
    "claimMapping": {
      "admin": { "claim": "groups", "value": "ythril-admin" },
      "readOnly": { "claim": "groups", "value": "ythril-readonly" },
      "spaces": { "claim": "ythril_spaces" }
    }
  }
}
```

### Auth0 Setup

1. In the Auth0 dashboard, go to **Applications → Create Application → Single Page Application**.
2. Set **Allowed Callback URLs** to `https://your-ythril-host/oidc-callback`.
3. Note the **Client ID** and **Domain** from the application settings.
4. The `issuerUrl` is `https://your-domain.auth0.com/`.
5. Set `audience` to your Auth0 API identifier if you have created a custom API; otherwise omit it.
6. To map roles, use **Auth0 Actions** (Login flow) to inject custom claims into the access token:

```js
// Auth0 Action — Login / Post Login
exports.onExecutePostLogin = async (event, api) => {
  const ns = 'https://ythril.example.com/';
  api.accessToken.setCustomClaim(ns + 'roles', event.authorization?.roles ?? []);
  api.accessToken.setCustomClaim(ns + 'spaces', event.user.app_metadata?.ythril_spaces ?? []);
};
```

```json
{
  "oidc": {
    "enabled": true,
    "issuerUrl": "https://your-domain.auth0.com/",
    "clientId": "YOUR_CLIENT_ID",
    "audience": "YOUR_API_IDENTIFIER",
    "scopes": ["openid", "profile", "email"],
    "claimMapping": {
      "admin": { "claim": "https://ythril.example.com/roles", "value": "ythril-admin" },
      "readOnly": { "claim": "https://ythril.example.com/roles", "value": "ythril-readonly" },
      "spaces": { "claim": "https://ythril.example.com/spaces" }
    }
  }
}
```

> **Note:** Auth0 requires namespaced custom claims (a URL prefix). Replace `https://ythril.example.com/` with your own namespace.

Any IdP configuration change is picked up automatically within about two seconds; run `POST /api/admin/reload-config` to apply it synchronously.

### Security Notes and Limitations

- **No server-side token revocation for OIDC.**  JWTs are validated statelessly (signature + `exp`).  Once issued by the IdP, a token is valid until it expires.  To revoke access, disable or remove the user at the IdP and set short token lifetimes (5–15 minutes recommended).
- **Silent token refresh.**  The SPA automatically schedules a background token refresh 60 seconds before the access token expires.  A hidden iframe is created with `prompt=none`; if the IdP session is still valid the user stays logged in with no interruption.  If the IdP session has also expired (or the IdP does not support `prompt=none`) the next API call returns 401 and the browser is redirected to the login page.  Configure your IdP's access token lifetime to balance UX vs security (5–15 minutes is a reasonable default).  This mechanism requires `Content-Security-Policy: frame-ancestors 'self'` (included in the default `frame-ancestors 'self'; object-src 'none'; base-uri 'self'; font-src 'self'` policy set by the server).
- **`admin` and `readOnly` cannot both match.**  If both claim rules match the same JWT, `admin: true` takes precedence and `readOnly` is ignored.  Design your IdP roles to be mutually exclusive.
- **Spaces claim controls visibility (fail-closed).**  When a `spaces` mapping is configured, the OIDC session can only see and modify the spaces named in that claim.  If the mapping is configured but the claim is missing or is not a string array, the allow-list is **empty (deny all)** — not "all spaces".  Users who cannot see expected spaces should check with their administrator that the IdP is emitting the correct claim values.
- **Config validation.**  When `oidc.enabled` is `true`, `issuerUrl` and `clientId` are required.  The server validates the OIDC config block at startup and on `reload-config` — a malformed block will prevent the server from starting.
- **Config reload.**  A change to the `oidc` block is picked up **automatically within about two seconds** — the server watches `config.json`, and the reload flushes the cached OIDC discovery document and JWKS key set. Call `POST /api/admin/reload-config` when you want the reload to be synchronous (a deploy script that must not race the next login), or restart the container. Neither is required.
- **Enforcing OIDC for browser sessions.**  Set `enforceForBrowser: true` to prevent users who have a cached PAT in their browser from bypassing the IdP.  When this flag is set the SPA clears any PAT-based localStorage session on startup and forces a fresh OIDC login.  Programmatic callers (API, MCP) that supply an `Authorization: ****** header are not affected.
- **Sign-out clears all browser auth state.**  Clicking the sign-out button always removes every Ythril auth key from `localStorage` regardless of whether the session was established via OIDC or a PAT.  For OIDC sessions the browser is additionally redirected to the IdP's `end_session_endpoint` (from the discovery document) with an `id_token_hint` so the Keycloak / IdP server-side session is also destroyed.  Without this step, `prompt=none` silent refresh would immediately re-authenticate the user.  Use `postLogoutRedirectUri` to control where the IdP sends the user after sign-out.
