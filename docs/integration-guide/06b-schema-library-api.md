# Schema Library

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Schema Library

### Schema Library

The Schema Library is an instance-level store of reusable `TypeSchema` definitions. Spaces can reference a library entry with `$ref` instead of duplicating the inline schema. Editing a library entry is reflected in every referencing space immediately — no space re-patch is needed.

Library entries are stored in `schema-library.json` (sibling to `config.json`). Max 500 entries per instance.

**A library entry's `propertySchemas` are validated by exactly the same grammar as an inline one** — the same
`type`/`enum`/`minimum`/`maximum`/`pattern`/`required`/`default`/`mergeFn` rules, the same `mergeFn`-versus-`type`
compatibility check, and the same refusal of an unknown key. Documented as a guarantee rather than a
coincidence: it used to be a second copy of the grammar in a second file, so a value one door accepted and the
other refused was possible and would have been invisible from both. It is now one object, shared, with a test
that parses the same values through both doors and requires the same verdict.

**One field differs, deliberately: `retention` is REFUSED on a library entry.** A delete window belongs to a
type in one space, not to a shape any number of spaces reference — and nothing resolves a `$ref` when a window
is read, so a window stored here would never fire. The refusal says so rather than accepting and ignoring it.

**Entry structure:**

```json
{
  "name": "service-v1",
  "knowledgeType": "entity",
  "typeName": "service",
  "description": "Standard service entity schema",
  "schema": {
    "namingPattern": "^[a-z][a-z0-9-]{1,60}$",
    "propertySchemas": {
      "owner": { "type": "string", "required": true },
      "status": { "type": "string", "enum": ["active", "deprecated"] }
    }
  },
  "createdAt": "2026-04-22T10:00:00.000Z",
  "updatedAt": "2026-04-22T10:00:00.000Z"
}
```

**Name format:** `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$` — alphanumeric (upper and lower), dots, dashes, and underscores. May not start with a dash, dot, or underscore. Max 200 characters.

#### List all entries

```http
GET /api/schema-library
Authorization: Bearer <token>
```

**Response** `200`:

```json
{ "entries": [ { "name": "...", ... } ] }
```

#### Get a single entry

```http
GET /api/schema-library/:name
Authorization: Bearer <token>
```

**Response** `200 { "entry": { ... } }` or `404`.

#### Get usages of an entry

Returns every space type definition that references this library entry via `$ref`.

```http
GET /api/schema-library/:name/usages
Authorization: Bearer <token>
```

**Response** `200`:

```json
{
  "usages": [
    {
      "spaceId": "my-space",
      "spaceLabel": "My Space",
      "knowledgeType": "entity",
      "typeName": "service"
    }
  ]
}
```

Returns an empty `usages` array if no space references the entry (including for names that do not exist in the library). Use this endpoint before deleting an entry to identify which spaces would lose their schema reference.

> **Library mutations require an admin token** — `POST`, `PUT`, and `DELETE` below are all admin-gated and MFA-protected (`requireAdminMfa`): send `Authorization: Bearer <admin-token>` and, when MFA is enabled, an `X-TOTP-Code: <code>` header, or the call returns `403`. The read endpoints (list, get, `…/usages`) accept any valid token.

#### Create an entry

```http
POST /api/schema-library
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "name": "service-v1",
  "knowledgeType": "entity",
  "typeName": "service",
  "schema": { "propertySchemas": { "owner": { "type": "string", "required": true } } },
  "description": "optional"
}
```

**Response** `201 { "entry": { ... } }`. Returns `409` if the name already exists (use `PUT` to update). Returns `400` for invalid payloads.

#### Create or replace an entry

```http
PUT /api/schema-library/:name
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "knowledgeType": "entity",
  "typeName": "service",
  "schema": { ... },
  "description": "optional"
}
```

**Response** `201` (created) or `200` (replaced). Returns `400` for invalid name format or payload.

**`PUT` replaces the `schema` wholesale**, and requires `knowledgeType`, `typeName` and `schema` every time.
That is the right verb when you are holding the whole entry — and the wrong one for changing a single
property, because it means resending every pre-existing property, which is how one gets dropped by accident.
Use `PATCH` for that.

#### Change part of an entry (merge)

```http
PATCH /api/schema-library/:name
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "schema": { "propertySchemas": { "region": { "type": "string" } } }
}
```

Every field is optional and **`schema.propertySchemas` merges by key**: the properties you name are added or
replaced, and the ones you do not name survive untouched. So the request above adds `region` without
restating `tier`, `owner`, the `namingPattern`, the description or the type name.

| field | behaviour |
|---|---|
| `schema.propertySchemas` | **merged per key.** A named property is REPLACED as a whole definition — naming it is how you change it, and deep-merging into it would make removing a constraint impossible |
| `schema.namingPattern` | replaced when present, preserved when absent. One value and one whole list; merging a list would leave no way to remove a single tag |
| `knowledgeType`, `typeName`, `published` | replaced when present |
| `description`, `schemaGroup`, `sourceUrl`, `sourceCatalog` | `null` clears, a value sets, absent preserves — the same three-way contract `PUT` honours |
| `deleteFields` | dot paths to remove: `propertySchemas.<key>`, `propertySchemas`, `namingPattern`, `tagSuggestions`. Applied **after** the merge, so one request can replace one property and drop another |

**Response** `200 { "entry": { ... } }`.

- `404` if the entry does not exist — **`PATCH` does not create**; use `PUT` for that. (Before this endpoint
  existed, a `PATCH` here returned a `404` from the router itself, which read as "not supported" because it
  was.)
- `400` if the body names no field at all, so a no-op cannot be mistaken for an applied change.
- `400` for an unrecognised `deleteFields` path, rather than ignoring it — a silently dropped typo would leave
  you believing a property was removed while it is still validating records.

Editing a library entry changes what **every space that `$ref`s it** validates against; use
`GET /api/schema-library/:name/usages` first if you need to know who that is.

#### Delete an entry

```http
DELETE /api/schema-library/:name
Authorization: Bearer <admin-token>
```

**Response** `204`. Returns `404` if not found.

> **Safe deletion:** Before deleting an entry, call `GET /api/schema-library/:name/usages` to find all spaces that reference it. For each usage, `PUT /api/spaces/:spaceId/meta/typeSchemas/:kt/:typeName` with the inline schema (copied from the library entry) to replace the `$ref` with a standalone definition. Once all references are replaced, the `DELETE` can proceed without breaking any space's validation.
>
> The admin UI performs this sequence automatically — it shows a warning with the affected spaces and an **Unlink & Delete** button that handles the replacement before deleting.

#### Schema groups

Library entries can carry a `schemaGroup` tag, letting a related set of type schemas be exported from and applied to spaces as a unit.

```http
GET /api/schema-library/groups
Authorization: Bearer <token>
```

**Response** `200 { "groups": [ { "name", "count" } ] }` — every distinct `schemaGroup` with the number of entries in it, sorted by name.

```http
POST /api/schema-library/export-space
Authorization: Bearer <admin-token>
Content-Type: application/json

{ "spaceId": "research", "groupName": "research-schemas", "namePrefix": "research" }
```

Creates or updates one library entry per **inline** type schema in the space's `meta.typeSchemas`, tagging them all with `groupName` (`$ref` entries are skipped — they are already library-backed). Entry names are derived as `<namePrefix|groupName>-<knowledgeType>-<typeName>`. **Response** `200 { "created", "updated", "entries": [ ... ] }`. Requires an admin token (and MFA when enabled).

```http
POST /api/schema-library/groups/:group/apply
Authorization: Bearer <admin-token>
Content-Type: application/json

{ "spaceId": "research-2" }
```

Injects a `$ref` into the target space's `typeSchemas` for every library entry in `:group`, wiring the space to the shared definitions. **Response** `200` with the applied entries; `404` if the group has no entries or the space does not exist. Requires an admin token (and MFA when enabled).

#### Using `$ref` in space typeSchemas

A space type definition can reference a library entry instead of embedding the schema inline:

```json
{
  "meta": {
    "validationMode": "strict",
    "typeSchemas": {
      "entity": {
        "service": { "$ref": "library:service-v1" }
      }
    }
  }
}
```

`resolveMetaRefs()` resolves all `$ref` pointers from the library before validation runs.

**You cannot store an unresolvable ref.** Every route that accepts `typeSchemas` — `POST /api/spaces`,
`PATCH /api/spaces/:id`, `PUT /api/spaces/:id/schema`, and the single-type
`PUT /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName` — answers **422** naming the missing library
entry, before anything is written. Creation used to be the one exception, which meant the identical mistake
was loud on every path except the one where a space and its schema arrive together.

If a ref does become unresolvable later — the library entry is deleted out from under a space that referenced
it — resolution degrades to an empty schema: no constraints are applied, identical to the behaviour for an
undefined type. That is a deliberate degrade rather than a hard failure, because a deleted library entry must
not make an existing space unwritable. In a `strict` space it does mean that type accepts anything, so treat
deleting a referenced library entry as a change to every space that points at it.

`$ref` and inline fields are mutually exclusive: a `TypeSchema` that contains `$ref` must not also contain `namingPattern`, `propertySchemas`, etc.

#### Publish an entry (make publicly accessible)

An entry can be published so that unauthenticated callers on the open internet can fetch it and import it into their own instance.

```http
PATCH /api/schema-library/:name/publish
Authorization: Bearer <admin-token>
Content-Type: application/json

{ "published": true }
```

To unpublish, send `{ "published": false }`.

**Response** `200 { "entry": { ... } }` (full updated entry). Returns `404` if the entry does not exist. Requires an **admin token**; returns `403` otherwise.

> **Security note:** Publishing only exposes the schema definition (field types, constraints, naming patterns, tag suggestions). It never exposes space data, facts, or any other tenant information.

#### Public listing

Returns all published entries. Rate-limited at 60 requests/minute per IP.

```http
GET /api/schema-library/public
```

No `Authorization` header is required for open instances. When the remote instance is behind an auth proxy (e.g. Cloudflare Access), pass a **library access token** as a Bearer credential:

```http
Authorization: Bearer <schemaLibrary-token>
```

An invalid or wrong-scope token returns `401`/`403`. A missing token on an open instance is accepted.

**Response** `200`:

```json
{
  "entries": [
    {
      "name": "service-v1",
      "knowledgeType": "entity",
      "typeName": "service",
      "description": "Standard service entity schema",
      "updatedAt": "2026-04-22T10:00:00.000Z"
    }
  ]
}
```

The listing exposes only metadata — the `schema` object is omitted. Fetch the individual entry to obtain the full schema.

#### Public single entry (unauthenticated)

```http
GET /api/schema-library/public/:name
```

**Response** `200 { "entry": { ... } }` — full entry including `schema`. Returns `404` if the entry does not exist or is not published.

---

#### Foreign catalogs

A **foreign catalog** is a link to another Ythril instance's public schema library. Linking a catalog lets you browse its published entries and import them into your own library. Imports are copied locally — they do not create live dependencies.

Catalog links are stored in `schema-catalogs.json` (sibling to `config.json`). Max 50 catalog links per instance.

##### List catalogs

```http
GET /api/schema-library/catalogs
Authorization: Bearer <token>
```

**Response** `200 { "catalogs": [ { "name", "url", "description", "createdAt", "hasAccessToken" } ] }`.

`hasAccessToken` is `true` when a library access token is stored for this catalog (used to authenticate against the remote). The plaintext token is never returned.

##### Add a catalog link

```http
POST /api/schema-library/catalogs
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "name": "acme-schemas",
  "url": "https://brain.acme.example/api/schema-library",
  "description": "ACME Corp shared schema catalog",
  "accessToken": "ythril_xK9mPq..."
}
```

**Fields:**

| Field | Required | Notes |
|---|---|---|
| `name` | ✓ | Unique catalog ID: `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$` |
| `url` | ✓ | Base URL of the remote schema library. Must be HTTPS; private/loopback addresses are rejected (SSRF protection). |
| `description` | — | Free text, up to 500 characters. |
| `accessToken` | — | A library access token issued by the remote instance. Required only when the remote's `/public` endpoint is behind an auth proxy (e.g. Cloudflare Access). Write-only: it is never returned in list or get responses — only `hasAccessToken: true/false` is exposed. It is held in the instance config directory, which is created with owner-only (`0600`) permissions. |

**Responses:** `201 { "catalog": { ..., "hasAccessToken": true } }`, `400` (invalid URL/name), `409` (name already exists), `400` (SSRF-blocked URL).

> **SSRF protection:** Private-range IPs (`10.x`, `172.16–31.x`, `192.168.x`), CGNAT (`100.64–127.x`), loopback (`127.x`, `::1`), link-local/IMDS (`169.254.x`, `169.254.169.254`), IPv6 ULA (`fc00::/7`), and GCP metadata are rejected — in every host encoding, including decimal/hex/octal/short-form IPv4 (e.g. `2130706433`, `0x7f000001`, `127.1`) and IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`). The target hostname is also resolved via DNS and every resolved address is validated, so a public name that points at an internal host is rejected too. Only the HTTPS scheme is accepted.

##### Remove a catalog link

```http
DELETE /api/schema-library/catalogs/:name
Authorization: Bearer <admin-token>
```

**Response** `204`. Returns `404` if not found. Removing a catalog link does not delete any entries that were already imported from it.

##### Browse a foreign catalog

Proxies a request to the remote catalog's public listing endpoint. Requires authentication on the local instance (the remote endpoint is public).

```http
GET /api/schema-library/catalogs/:name/entries
Authorization: Bearer <token>
```

**Response** `200 { "catalog": "acme-schemas", "entries": [ { name, knowledgeType, typeName, description, updatedAt } ] }`.

Returns `404` if the catalog link is unknown. Returns `502` if the remote endpoint returns a non-200 response **or the request times out** (8 s). (A `504` is only produced when the remote itself responds with `504`.)

##### Fetch a single entry from a foreign catalog

```http
GET /api/schema-library/catalogs/:name/entries/:entryName
Authorization: Bearer <token>
```

**Response** `200 { "catalog": "acme-schemas", "entry": { ... } }` — full entry including `schema`. Returns `404` or `502` as above.

Use this endpoint to obtain the full schema before importing. To import, call `PUT /api/schema-library/:name` on your local instance with the fetched schema. Pass `sourceCatalog` in the body to record the origin:

```json
{
  "knowledgeType": "entity",
  "typeName": "service",
  "schema": { "..." },
  "description": "Imported from acme-schemas",
  "sourceCatalog": "acme-schemas"
}
```

---

```http
DELETE /api/spaces/:id
Content-Type: application/json

{ "confirm": true }
```

**Response** `204`. If the space participates in a network, deletion requires a governance vote.

If cleanup partially fails (e.g. a collection drop or file deletion errors), the server returns `500` with error details. The space is **not** removed from config so the deletion can be retried. Check the response body for specifics:

```json
{ "error": "Space 'research' cleanup incomplete (2 error(s)). Space was NOT removed from config. ..." }
```

---
