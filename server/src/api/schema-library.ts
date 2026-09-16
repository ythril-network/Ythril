/**
 * Instance-level schema library CRUD API.
 *
 * Provides reusable TypeSchema definitions that spaces can reference via
 * `$ref: "library:<name>"` in their typeSchemas instead of duplicating
 * schema definitions inline.
 *
 * Routes (authenticated):
 *   GET    /api/schema-library                        — list all entries
 *   GET    /api/schema-library/:name                  — get a single entry
 *   GET    /api/schema-library/:name/usages           — list space $ref usages
 *   POST   /api/schema-library                        — create a new entry
 *   PUT    /api/schema-library/:name                  — create or replace an entry
 *   PATCH  /api/schema-library/:name/publish          — publish or unpublish an entry
 *   DELETE /api/schema-library/:name                  — remove an entry
 *   GET    /api/schema-library/catalogs               — list foreign catalog links
 *   POST   /api/schema-library/catalogs               — add a foreign catalog link
 *   DELETE /api/schema-library/catalogs/:name         — remove a foreign catalog link
 *   GET    /api/schema-library/catalogs/:name/entries — browse a foreign catalog (proxied)
 *   GET    /api/schema-library/catalogs/:name/entries/:entryName — preview one foreign entry
 *   GET    /api/schema-library/groups                 — list distinct schema group names
 *   POST   /api/schema-library/groups/:group/apply    — apply all entries in a group to a space
 *   POST   /api/schema-library/export-space           — export a space's typeSchemas as a named group
 *
 * Routes (unauthenticated, public):
 *   GET    /api/schema-library/public                 — index of published entries
 *   GET    /api/schema-library/public/:name           — a single published entry
 */

import { Router } from 'express';
import { boundedJson } from '../util/bounded-read.js';
import { requireAuth, requireAdminMfa, acceptSchemaLibraryToken } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getSchemaLibrary, saveSchemaLibrary, getConfig, getSchemaCatalogs, saveSchemaCatalogs } from '../config/loader.js';
import { updateSpace } from '../spaces/spaces.js';
import { isSsrfSafeUrl, ssrfSafeFetch } from '../util/ssrf.js';
import { z } from 'zod';
import { PropertySchemaZ } from '../spaces/body-schemas.js';
import rateLimit from 'express-rate-limit';
import type { SchemaLibraryEntry, SchemaCatalog } from '../config/types.js';
import { KNOWLEDGE_TYPES } from '../config/types.js';
import { EndpointMemberZ } from '../spaces/body-schemas.js';

export const schemaLibraryRouter = Router();

// ── Rate limiters ──────────────────────────────────────────────────────────

/** 60 req/min per IP for unauthenticated public read endpoints. */
const publicRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded.' },
});

/** 20 req/min per IP for catalog proxy (each call makes an outbound fetch). */
const catalogProxyRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Catalog proxy rate limit exceeded.' },
});

// ── Validation ─────────────────────────────────────────────────────────────

const MAX_LIBRARY_ENTRIES = 500;
const MAX_CATALOGS = 50;
const CATALOG_PROXY_TIMEOUT_MS = 8_000;

/*
 * The property-schema grammar is IMPORTED, not re-declared.
 *
 * This file used to carry its own copy under the comment *"matches spaces.ts PropertySchemaZ"* — a validation
 * grammar duplicated and acknowledged in a comment rather than shared. The two were character-identical when
 * that was noticed, which is exactly the danger: nothing was wrong yet, and nothing would have said when it
 * went wrong. A property schema decides what values a caller may STORE, so two copies means a value the inline
 * door accepts and this one refuses, or the reverse, invisible from either side.
 *
 * The library's schema still DIFFERS in one place, deliberately, and that difference is now the only one it
 * can have: `retention` is refused below, because nothing resolves a `$ref` when a window is read.
 */

/**
 * Zod schema for the inline TypeSchema stored in library entries.
 *
 * `$ref` is not permitted inside a library entry (no recursive references).
 *
 * ## `retention` is refused ON PURPOSE, and now says so
 *
 * A library entry is referenced by any number of spaces, and a delete policy is not a property of a shape — so a
 * window belongs to a type IN a space, never to the library definition. That decision predates this comment and is
 * already documented in `04-brain-api.md`; the client strips the field before saving to the library
 * (`typeSchemaFromState(..., { withRetention: false })`).
 *
 * What was missing was the explanation at the point of refusal. `.strict()` alone answers `Unrecognized key(s) in
 * object: 'retention'`, which tells a direct API caller that a field valid one place is invalid here and nothing
 * about why. Declaring the key with a message that fails is uglier than omitting it, and worth it: the alternative
 * is a caller reading the Zod error and concluding it is a bug.
 *
 * Anything else unrecognised still falls through to `.strict()`, because a generic rejection is the right answer for
 * a genuine typo — this is only for the one field whose absence is a design decision rather than an oversight.
 */
export const LibraryTypeSchemaZ = z.object({
  namingPattern: z.string().max(500).optional(),
  propertySchemas: z.record(z.string().min(1).max(200), PropertySchemaZ).optional(),
  // Kept in step with `TypeSchemaZ` in `api/spaces.ts` deliberately: a library entry that cannot express a field the
  // inline schema can is a surface that silently drops it.
  suppressEmbeddings: z.boolean().optional(),
  /*
    * ACCEPTED here, unlike `retention` below, and the distinction is shape versus policy.
    *
    * A retention window is a decision about one space's data, so it cannot travel with an entry that any number
    * of spaces reference. What may sit at each end of a `reports_to` edge, and whether a subject may have more
    * than one, are facts about the SHAPE — which is the thing a library entry exists to carry. Refusing them
    * would make this surface silently less expressive than the inline one, which the comment above this object
    * already names as the failure to avoid.
    *
    * `EndpointMemberZ` is imported rather than restated: the grammar is reserved (`entity:` accepted, other
    * knowledge-type prefixes refused with a reason), and a second spelling of a reserved grammar is a second
    * thing to keep in step. `PropertySchemaZ` was exactly that until 2026-09-02 and is now imported too, so
    * this object's ONLY difference from the inline one is the `retention` refusal below.
    */
  endpoints: z.object({
    from: z.array(EndpointMemberZ).min(1).max(50).optional(),
    to: z.array(EndpointMemberZ).min(1).max(50).optional(),
  }).strict().refine(v => v.from !== undefined || v.to !== undefined, {
    message: 'endpoints needs from, to, or both — an empty object constrains nothing and is more likely a typo',
  }).optional(),
  functional: z.boolean().optional(),
  retention: z.never({
    message: 'retention cannot be set on a schema-library entry: one entry is referenced by any number of spaces, '
      + 'and a delete window belongs to a type in a space rather than to the shape. Set it on the type after '
      + 'resolving the $ref to an inline definition, or use the space-wide recordTtlDays.',
  }).optional(),
}).strict();

/** Name must be URL-safe and reasonably short. Allows uppercase, dots, dashes, underscores. */
const LIBRARY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;

const LibraryEntryBodyZ = z.object({
  name: z.string().min(1).max(200).regex(LIBRARY_NAME_RE, 'name must start with an alphanumeric character and contain only letters, digits, dots, dashes, or underscores'),
  knowledgeType: z.enum(KNOWLEDGE_TYPES),
  typeName: z.string().min(1).max(200),
  schema: LibraryTypeSchemaZ,
  description: z.string().max(1000).optional(),
  schemaGroup: z.string().min(1).max(200).optional(),
  published: z.boolean().optional(),
  sourceUrl: z.string().url().max(2048).optional(),
  sourceCatalog: z.string().max(200).optional(),
});

/** Body for PUT (name comes from the URL param). */
const LibraryEntryPutBodyZ = z.object({
  knowledgeType: z.enum(KNOWLEDGE_TYPES),
  typeName: z.string().min(1).max(200),
  schema: LibraryTypeSchemaZ,
  /** Pass null to explicitly clear a previously set description. */
  description: z.string().max(1000).nullable().optional(),
  /** Pass null to explicitly clear a previously set group. */
  schemaGroup: z.string().min(1).max(200).nullable().optional(),
  published: z.boolean().optional(),
  sourceUrl: z.string().url().max(2048).nullable().optional(),
  sourceCatalog: z.string().max(200).nullable().optional(),
});

/**
 * Body for `PATCH /:name` — every field optional, and `schema` MERGES.
 *
 * The gap this closes, reported by an integrator: `PUT` requires `knowledgeType`, `typeName` and the whole
 * `schema`, and replaces `schema` wholesale. So adding one optional property meant resending the type name,
 * the description and **every pre-existing property** — precisely the shape in which a property gets dropped
 * by accident. They had resorted to asserting afterwards that nothing was lost and no enum had narrowed,
 * which is a workaround for a missing merge.
 *
 * `deleteFields` rather than a new convention: the brain record routes already use dot-notation paths for
 * removal, so an integrator who has used `PATCH .../facts/:id` already knows this. Two vocabularies for
 * one operation is how they diverge.
 */
const LibraryEntryPatchBodyZ = z.object({
  knowledgeType: z.enum(KNOWLEDGE_TYPES).optional(),
  typeName: z.string().min(1).max(200).optional(),
  schema: LibraryTypeSchemaZ.optional(),
  description: z.string().max(1000).nullable().optional(),
  schemaGroup: z.string().min(1).max(200).nullable().optional(),
  published: z.boolean().optional(),
  sourceUrl: z.string().url().max(2048).nullable().optional(),
  sourceCatalog: z.string().max(200).nullable().optional(),
  /** Dot paths inside `schema`: `propertySchemas.<key>`, `namingPattern`, `propertySchemas`. */
  deleteFields: z.array(z.string().min(1).max(300)).max(100).optional(),
}).strict();

/** Body for PATCH /:name/publish */
const PublishPatchZ = z.object({
  published: z.boolean(),
});

/** Body for POST /catalogs */
const CATALOG_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const CatalogBodyZ = z.object({
  name: z.string().min(1).max(100).regex(CATALOG_NAME_RE, 'catalog name must start with an alphanumeric character and contain only letters, digits, dots, dashes, or underscores'),
  url: z.string().url().max(2048)
    .refine(u => { try { return new URL(u).protocol === 'https:'; } catch { return false; } }, { message: 'Catalog URL must use HTTPS.' })
    .refine(u => isSsrfSafeUrl(u), { message: 'Catalog URL must not target private IPs, loopback, or cloud metadata endpoints.' }),
  description: z.string().max(500).optional(),
  /** Bearer token forwarded when proxying requests to this catalog's /public endpoint. */
  accessToken: z.string().min(1).max(500).optional(),
});

// ── GET / — list all library entries ──────────────────────────────────────

schemaLibraryRouter.get('/', globalRateLimit, requireAuth, (_req, res) => {
  res.json({ entries: getSchemaLibrary() });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Public endpoints — unauthenticated, rate-limited
//  MUST be registered before GET /:name to avoid the generic pattern
//  shadowing these literal paths.
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /public — index of published entries ─────────────────────────────

schemaLibraryRouter.get('/public', publicRateLimit, acceptSchemaLibraryToken, (_req, res) => {
  const published = getSchemaLibrary()
    .filter(e => e.published)
    .map(({ name, knowledgeType, typeName, description, updatedAt }) => ({
      name, knowledgeType, typeName, description, updatedAt,
    }));
  res.json({ entries: published });
});

// ── GET /public/:name — a single published entry ─────────────────────────

schemaLibraryRouter.get('/public/:name', publicRateLimit, acceptSchemaLibraryToken, (req, res) => {
  const name = req.params['name'] as string;
  const entry = getSchemaLibrary().find(e => e.name === name);

  if (!entry || !entry.published) {
    res.status(404).json({ error: `Published schema library entry '${name}' not found` });
    return;
  }

  // Return the full entry (schema + metadata) so consumers can import it
  res.json({ entry: { name: entry.name, knowledgeType: entry.knowledgeType, typeName: entry.typeName, schema: entry.schema, description: entry.description, updatedAt: entry.updatedAt } });
});

// ── GET /catalogs — list catalog links ────────────────────────────────────
// Must precede GET /:name to avoid 'catalogs' being treated as a library entry name.
schemaLibraryRouter.get('/catalogs', globalRateLimit, requireAuth, (_req, res) => {
  // Never expose stored accessToken values — return a boolean flag instead
  const catalogs = getSchemaCatalogs().map(({ accessToken, ...rest }) => ({
    ...rest,
    hasAccessToken: !!accessToken,
  }));
  res.json({ catalogs });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Schema group endpoints — must precede GET /:name
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /groups — list all distinct schema groups ─────────────────────────

schemaLibraryRouter.get('/groups', globalRateLimit, requireAuth, (_req, res) => {
  const library = getSchemaLibrary();
  const groupMap = new Map<string, number>();
  for (const entry of library) {
    if (entry.schemaGroup) {
      groupMap.set(entry.schemaGroup, (groupMap.get(entry.schemaGroup) ?? 0) + 1);
    }
  }
  const groups = Array.from(groupMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ groups });
});

// ── POST /export-space — export a space's typeSchemas as a named group ────
//
//  Body: { spaceId: string; groupName: string; namePrefix?: string }
//  Creates (or updates) one library entry per inline type schema found in the
//  space's meta.typeSchemas.  Entries tagged with `$ref` are skipped (they are
//  already backed by a library entry).  Entry names are derived as:
//    <namePrefix|groupName>-<knowledgeType>-<typeName>   (sanitised)
//  Returns the list of created/updated entries.

const ExportSpaceBodyZ = z.object({
  spaceId: z.string().min(1).max(200),
  groupName: z.string().min(1).max(200),
  namePrefix: z.string().min(1).max(200).optional(),
});

schemaLibraryRouter.post('/export-space', globalRateLimit, requireAdminMfa, (req, res) => {
  const parsed = ExportSpaceBodyZ.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { spaceId, groupName, namePrefix } = parsed.data;
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  const typeSchemas = space.meta?.typeSchemas;
  if (!typeSchemas) {
    res.json({ created: 0, updated: 0, entries: [] });
    return;
  }

  const prefix = (namePrefix ?? groupName)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 100);

  const library = getSchemaLibrary();
  const now = new Date().toISOString();
  const kts = KNOWLEDGE_TYPES;
  const resultEntries: SchemaLibraryEntry[] = [];
  let created = 0;
  let updated = 0;

  for (const kt of kts) {
    const ktMap = typeSchemas[kt];
    if (!ktMap) continue;
    for (const [typeName, schema] of Object.entries(ktMap)) {
      // Skip $ref entries — they already point at a library entry
      if ('$ref' in schema) continue;

      const safeName = typeName.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 80);
      const entryName = `${prefix}-${kt}-${safeName}`.slice(0, 200);

      const existingIdx = library.findIndex(e => e.name === entryName);

      // Inline schema (no $ref) — store as-is (already compatible with LibraryTypeSchema)
      const inlineSchema: Omit<import('../config/types.js').TypeSchema, '$ref'> = schema as Omit<import('../config/types.js').TypeSchema, '$ref'>;

      if (existingIdx === -1) {
        if (library.length >= MAX_LIBRARY_ENTRIES) {
          // Stop if limit reached — still return what was exported so far
          break;
        }
        const newEntry: SchemaLibraryEntry = {
          name: entryName,
          knowledgeType: kt,
          typeName,
          schema: inlineSchema,
          schemaGroup: groupName,
          createdAt: now,
          updatedAt: now,
        };
        library.push(newEntry);
        resultEntries.push(newEntry);
        created++;
      } else {
        const updatedEntry: SchemaLibraryEntry = {
          ...library[existingIdx]!,
          knowledgeType: kt,
          typeName,
          schema: inlineSchema,
          schemaGroup: groupName,
          updatedAt: now,
        };
        library[existingIdx] = updatedEntry;
        resultEntries.push(updatedEntry);
        updated++;
      }
    }
  }

  saveSchemaLibrary(library);
  res.json({ created, updated, entries: resultEntries });
});

// ── POST /groups/:group/apply — apply all entries in a group to a space ───
//
//  Body: { spaceId: string }
//  Creates `$ref: "library:<name>"` entries in the target space's typeSchemas
//  for every library entry that belongs to the specified group.
//  Existing type definitions for matching names are overwritten.

const ApplyGroupBodyZ = z.object({
  spaceId: z.string().min(1).max(200),
});

schemaLibraryRouter.post('/groups/:group/apply', globalRateLimit, requireAdminMfa, (req, res) => {
  const group = req.params['group'] as string;
  const parsed = ApplyGroupBodyZ.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { spaceId } = parsed.data;
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  const groupEntries = getSchemaLibrary().filter(e => e.schemaGroup === group);
  if (groupEntries.length === 0) {
    res.status(404).json({ error: `No library entries found for group '${group}'` });
    return;
  }

  // Build updated typeSchemas by injecting $ref entries
  const existingMeta = space.meta ?? {};
  const typeSchemas = { ...existingMeta.typeSchemas };

  const applied: { knowledgeType: string; typeName: string; entryName: string }[] = [];

  for (const entry of groupEntries) {
    const kt = entry.knowledgeType;
    const ktMap = { ...(typeSchemas[kt] ?? {}) };
    ktMap[entry.typeName] = { $ref: `library:${entry.name}` };
    typeSchemas[kt] = ktMap;
    applied.push({ knowledgeType: kt, typeName: entry.typeName, entryName: entry.name });
  }

  const updated = updateSpace(spaceId, {
    meta: { ...existingMeta, typeSchemas },
  });

  if (!updated) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  res.json({ applied, count: applied.length });
});

// ── GET /:name — get a single library entry ────────────────────────────────

schemaLibraryRouter.get('/:name', globalRateLimit, requireAuth, (req, res) => {
  const name = req.params['name'] as string;
  const entry = getSchemaLibrary().find(e => e.name === name);
  if (!entry) {
    res.status(404).json({ error: `Schema library entry '${name}' not found` });
    return;
  }
  res.json({ entry });
});

// ── POST / — create a new library entry ───────────────────────────────────

schemaLibraryRouter.post('/', globalRateLimit, requireAdminMfa, (req, res) => {
  const parsed = LibraryEntryBodyZ.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, knowledgeType, typeName, schema, description, schemaGroup, published, sourceUrl, sourceCatalog } = parsed.data;
  const library = getSchemaLibrary();

  if (library.some(e => e.name === name)) {
    res.status(409).json({ error: `Schema library entry '${name}' already exists. Use PUT to update it.` });
    return;
  }

  if (library.length >= MAX_LIBRARY_ENTRIES) {
    res.status(400).json({ error: `Maximum of ${MAX_LIBRARY_ENTRIES} library entries reached. Remove unused entries before adding new ones.` });
    return;
  }

  const now = new Date().toISOString();
  const entry: SchemaLibraryEntry = {
    name,
    knowledgeType,
    typeName,
    schema,
    ...(description ? { description } : {}),
    ...(schemaGroup ? { schemaGroup } : {}),
    ...(published ? { published } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceCatalog ? { sourceCatalog } : {}),
    createdAt: now,
    updatedAt: now,
  };

  saveSchemaLibrary([...library, entry]);
  res.status(201).json({ entry });
});

// ── PUT /:name — create or replace a library entry ────────────────────────

schemaLibraryRouter.put('/:name', globalRateLimit, requireAdminMfa, (req, res) => {
  const name = req.params['name'] as string;

  if (!LIBRARY_NAME_RE.test(name)) {
    res.status(400).json({ error: 'Invalid library entry name. Must be lowercase alphanumeric with optional dashes/underscores.' });
    return;
  }

  const parsed = LibraryEntryPutBodyZ.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { knowledgeType, typeName, schema, description, schemaGroup, published, sourceUrl, sourceCatalog } = parsed.data;

  const library = getSchemaLibrary();
  const existingIdx = library.findIndex(e => e.name === name);

  if (existingIdx === -1 && library.length >= MAX_LIBRARY_ENTRIES) {
    res.status(400).json({ error: `Maximum of ${MAX_LIBRARY_ENTRIES} library entries reached. Remove unused entries before adding new ones.` });
    return;
  }

  const now = new Date().toISOString();
  const isNew = existingIdx === -1;

  if (isNew) {
    const newEntry: SchemaLibraryEntry = {
      name,
      knowledgeType,
      typeName,
      schema,
      ...(description ? { description } : {}),
      ...(schemaGroup ? { schemaGroup } : {}),
      ...(published ? { published } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(sourceCatalog ? { sourceCatalog } : {}),
      createdAt: now,
      updatedAt: now,
    };
    saveSchemaLibrary([...library, newEntry]);
    res.status(201).json({ entry: newEntry });
  } else {
    const existing = library[existingIdx]!;
    const updatedEntry: SchemaLibraryEntry = {
      ...existing,
      knowledgeType,
      typeName,
      schema,
      // null explicitly clears; undefined preserves existing; string updates
      ...(description === null
        ? { description: undefined }
        : description !== undefined
          ? { description }
          : existing.description !== undefined ? { description: existing.description } : {}),
      ...(schemaGroup === null
        ? { schemaGroup: undefined }
        : schemaGroup !== undefined
          ? { schemaGroup }
          : existing.schemaGroup !== undefined ? { schemaGroup: existing.schemaGroup } : {}),
      ...(published !== undefined ? { published } : {}),
      ...(sourceUrl === null
        ? { sourceUrl: undefined }
        : sourceUrl !== undefined ? { sourceUrl } : existing.sourceUrl !== undefined ? { sourceUrl: existing.sourceUrl } : {}),
      ...(sourceCatalog === null
        ? { sourceCatalog: undefined }
        : sourceCatalog !== undefined ? { sourceCatalog } : existing.sourceCatalog !== undefined ? { sourceCatalog: existing.sourceCatalog } : {}),
      updatedAt: now,
    };
    const updatedLibrary = [...library];
    updatedLibrary[existingIdx] = updatedEntry;
    saveSchemaLibrary(updatedLibrary);
    // A library entry is referenced by `$ref` from any number of spaces, so editing one changes what all
    // of them validate against. The audit layer records the scalar metadata plus the property-key names
    // that changed — never the property schemas, which can carry example values.
    req.auditSnapshots = { before: existing, after: updatedEntry };
    res.json({ entry: updatedEntry });
  }
});

// ── PATCH /:name — merge into an existing entry ───────────────────────────────
//
// `PUT` remains the full replace, and is still the right verb when you hold the whole entry. This is for the
// case that produced the report: change one thing without restating everything else.
//
// It does NOT create. A `404` here means "no such entry", which is a different fact from the `404` an
// integrator used to get — that one was Express refusing an unrouted method, and it read as "PATCH is not
// supported" because it was.

schemaLibraryRouter.patch('/:name', globalRateLimit, requireAdminMfa, (req, res) => {
  const name = req.params['name'] as string;

  if (!LIBRARY_NAME_RE.test(name)) {
    res.status(400).json({ error: 'Invalid library entry name. Must be lowercase alphanumeric with optional dashes/underscores.' });
    return;
  }

  const parsed = LibraryEntryPatchBodyZ.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const patch = parsed.data;

  // A patch that names nothing is a request that cannot be carried out, and answering 200 to it would make a
  // no-op indistinguishable from an applied change — the same trap the brain PATCH handlers now refuse.
  const named = Object.keys(patch).filter(k => patch[k as keyof typeof patch] !== undefined);
  if (named.length === 0) {
    res.status(400).json({ error: 'At least one field must be provided' });
    return;
  }

  const library = getSchemaLibrary();
  const idx = library.findIndex(e => e.name === name);
  if (idx === -1) {
    res.status(404).json({ error: `Library entry '${name}' not found. Use PUT to create one.` });
    return;
  }
  const existing = library[idx]!;

  // Merge the schema: named properties are added or replaced, unnamed ones survive. `namingPattern`
  // replaces when present rather than merging.
  const mergedSchema: SchemaLibraryEntry['schema'] = { ...(existing.schema ?? {}) };
  if (patch.schema) {
    if (patch.schema.namingPattern !== undefined) mergedSchema.namingPattern = patch.schema.namingPattern;
    if (patch.schema.propertySchemas !== undefined) {
      mergedSchema.propertySchemas = { ...(existing.schema?.propertySchemas ?? {}), ...patch.schema.propertySchemas };
    }
  }

  // Removals, applied AFTER the merge so a single request can replace one property and drop another without
  // the order mattering to the caller.
  const unknownPaths: string[] = [];
  for (const path of patch.deleteFields ?? []) {
    if (path === 'namingPattern') { delete mergedSchema.namingPattern; continue; }
    if (path === 'propertySchemas') { delete mergedSchema.propertySchemas; continue; }
    const prop = /^propertySchemas\.(.+)$/.exec(path);
    if (prop && mergedSchema.propertySchemas) { delete mergedSchema.propertySchemas[prop[1]!]; continue; }
    if (prop) continue;   // nothing to delete from, but the path is valid
    unknownPaths.push(path);
  }
  if (unknownPaths.length > 0) {
    // Refused rather than ignored: a typo'd path that is silently dropped leaves the caller believing a
    // property was removed when it is still validating records.
    res.status(400).json({
      error: `deleteFields paths must be 'namingPattern', 'propertySchemas', or 'propertySchemas.<key>' — unrecognised: ${unknownPaths.join(', ')}`,
    });
    return;
  }

  const now = new Date().toISOString();
  const updated: SchemaLibraryEntry = {
    ...existing,
    ...(patch.knowledgeType !== undefined ? { knowledgeType: patch.knowledgeType } : {}),
    ...(patch.typeName !== undefined ? { typeName: patch.typeName } : {}),
    schema: mergedSchema,
    // null clears, a value sets, absent preserves — the same three-way contract PUT already honours for these.
    ...(patch.description === null ? { description: undefined } : patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.schemaGroup === null ? { schemaGroup: undefined } : patch.schemaGroup !== undefined ? { schemaGroup: patch.schemaGroup } : {}),
    ...(patch.published !== undefined ? { published: patch.published } : {}),
    ...(patch.sourceUrl === null ? { sourceUrl: undefined } : patch.sourceUrl !== undefined ? { sourceUrl: patch.sourceUrl } : {}),
    ...(patch.sourceCatalog === null ? { sourceCatalog: undefined } : patch.sourceCatalog !== undefined ? { sourceCatalog: patch.sourceCatalog } : {}),
    updatedAt: now,
  };

  const next = [...library];
  next[idx] = updated;
  saveSchemaLibrary(next);
  // Same reasoning as PUT: this entry is `$ref`d from any number of spaces, so editing it changes what all of
  // them validate against. The audit layer records the scalar metadata and which property KEYS changed, never
  // the property schemas themselves, which can carry example values.
  req.auditSnapshots = { before: existing, after: updated };
  res.json({ entry: updated });
});

// ── GET /:name/usages — list all spaces that $ref this library entry ─────────

schemaLibraryRouter.get('/:name/usages', globalRateLimit, requireAuth, (req, res) => {
  const name = req.params['name'] as string;
  const refValue = `library:${name}`;
  const kts = KNOWLEDGE_TYPES;

  const usages: { spaceId: string; spaceLabel: string; knowledgeType: string; typeName: string }[] = [];
  for (const space of getConfig().spaces) {
    const ts = space.meta?.typeSchemas;
    if (!ts) continue;
    for (const kt of kts) {
      const ktMap = ts[kt];
      if (!ktMap) continue;
      for (const [typeName, schema] of Object.entries(ktMap)) {
        if ((schema as { $ref?: string }).$ref === refValue) {
          usages.push({ spaceId: space.id, spaceLabel: space.label, knowledgeType: kt, typeName });
        }
      }
    }
  }
  res.json({ usages });
});

// ── DELETE /:name — remove a library entry ─────────────────────────────────

schemaLibraryRouter.delete('/:name', globalRateLimit, requireAdminMfa, (req, res) => {
  const name = req.params['name'] as string;
  const library = getSchemaLibrary();
  const idx = library.findIndex(e => e.name === name);

  if (idx === -1) {
    res.status(404).json({ error: `Schema library entry '${name}' not found` });
    return;
  }

  saveSchemaLibrary(library.filter(e => e.name !== name));
  res.status(204).end();
});

// ── PATCH /:name/publish — publish or unpublish an entry ─────────────────

schemaLibraryRouter.patch('/:name/publish', globalRateLimit, requireAdminMfa, (req, res) => {
  const name = req.params['name'] as string;
  const library = getSchemaLibrary();
  const idx = library.findIndex(e => e.name === name);

  if (idx === -1) {
    res.status(404).json({ error: `Schema library entry '${name}' not found` });
    return;
  }

  const parsed = PublishPatchZ.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updated = [...library];
  updated[idx] = { ...updated[idx]!, published: parsed.data.published, updatedAt: new Date().toISOString() };
  saveSchemaLibrary(updated);
  res.json({ entry: updated[idx] });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Foreign catalog link management
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /catalogs — add a new catalog link ───────────────────────────────

schemaLibraryRouter.post('/catalogs', globalRateLimit, requireAdminMfa, (req, res) => {
  const parsed = CatalogBodyZ.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const catalogs = getSchemaCatalogs();
  if (catalogs.some(c => c.name === parsed.data.name)) {
    res.status(409).json({ error: `Catalog '${parsed.data.name}' already exists.` });
    return;
  }
  if (catalogs.length >= MAX_CATALOGS) {
    res.status(400).json({ error: `Maximum of ${MAX_CATALOGS} catalog links reached.` });
    return;
  }

  const catalog: SchemaCatalog = {
    name: parsed.data.name,
    url: parsed.data.url,
    ...(parsed.data.description ? { description: parsed.data.description } : {}),
    ...(parsed.data.accessToken ? { accessToken: parsed.data.accessToken } : {}),
    createdAt: new Date().toISOString(),
  };
  saveSchemaCatalogs([...catalogs, catalog]);
  // Return catalog without exposing the stored accessToken
  const { accessToken: _at, ...safeCatalog } = catalog;
  res.status(201).json({ catalog: { ...safeCatalog, hasAccessToken: !!catalog.accessToken } });
});

// ── DELETE /catalogs/:name — remove a catalog link ────────────────────────

schemaLibraryRouter.delete('/catalogs/:name', globalRateLimit, requireAdminMfa, (req, res) => {
  const name = req.params['name'] as string;
  const catalogs = getSchemaCatalogs();
  if (!catalogs.some(c => c.name === name)) {
    res.status(404).json({ error: `Catalog '${name}' not found.` });
    return;
  }
  saveSchemaCatalogs(catalogs.filter(c => c.name !== name));
  res.status(204).end();
});

// ─────────────────────────────────────────────────────────────────────────────
//  Catalog proxy — server-side fetch to avoid browser CORS and validate SSRF
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch a foreign URL with timeout and basic safety checks. */
async function proxyCatalogFetch(url: string, accessToken?: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_PROXY_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'Ythril-CatalogProxy/1.0' };
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    // ssrfSafeFetch (not bare fetch): the catalog URL passed `isSsrfSafeUrl` at creation time, but that
    // is a static string check — it does not resolve DNS and does not re-check redirect targets. A
    // catalog host can rebind to an internal IP, or 3xx-redirect to one (IMDS, internal services), and
    // bare `fetch` defaults to redirect:'follow'. ssrfSafeFetch resolves + pins + re-validates every hop.
    // External catalogs must never reach private space, so allowPrivate stays false (the default).
    const resp = await ssrfSafeFetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    const body = await boundedJson<unknown>(resp, 'schema library peer').catch(() => null);
    return { ok: resp.ok, status: resp.status, body };
  } catch (err: unknown) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, body: { error: `Catalog fetch failed: ${message}` } };
  }
}

// ── GET /catalogs/:name/entries — browse a foreign catalog (proxied) ─────

schemaLibraryRouter.get('/catalogs/:name/entries', catalogProxyRateLimit, requireAuth, async (req, res) => {
  const catalogName = req.params['name'] as string;
  const catalog = getSchemaCatalogs().find(c => c.name === catalogName);
  if (!catalog) {
    res.status(404).json({ error: `Catalog '${catalogName}' not found.` });
    return;
  }

  // Build the index URL (ensure no double slash)
  const indexUrl = catalog.url.replace(/\/$/, '') + (catalog.url.endsWith('/public') ? '' : '/public');

  const result = await proxyCatalogFetch(indexUrl, catalog.accessToken);
  if (!result.ok) {
    // Normalize all upstream errors to 502 — never forward upstream status codes.
    const outStatus = result.status === 504 ? 504 : 502;
    res.status(outStatus).json(result.body);
    return;
  }
  res.json({ catalog: catalogName, ...( result.body as object) });
});

// ── GET /catalogs/:name/entries/:entryName — preview one foreign entry ────

schemaLibraryRouter.get('/catalogs/:name/entries/:entryName', catalogProxyRateLimit, requireAuth, async (req, res) => {
  const catalogName = req.params['name'] as string;
  const entryName  = req.params['entryName'] as string;

  const catalog = getSchemaCatalogs().find(c => c.name === catalogName);
  if (!catalog) {
    res.status(404).json({ error: `Catalog '${catalogName}' not found.` });
    return;
  }

  const base = catalog.url.replace(/\/$/, '');
  const entryUrl = (base.endsWith('/public') ? base : base + '/public') + '/' + encodeURIComponent(entryName);

  const result = await proxyCatalogFetch(entryUrl, catalog.accessToken);
  if (!result.ok) {
    // Normalize all upstream errors to 502 — never forward upstream status codes.
    const outStatus = result.status === 504 ? 504 : 502;
    res.status(outStatus).json(result.body);
    return;
  }
  res.json({ catalog: catalogName, ...(result.body as object) });
});
