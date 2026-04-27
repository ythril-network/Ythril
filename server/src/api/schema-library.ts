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
import { requireAuth, requireAdminMfa, acceptSchemaLibraryToken } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getSchemaLibrary, saveSchemaLibrary, getConfig, getSchemaCatalogs, saveSchemaCatalogs } from '../config/loader.js';
import { updateSpace } from '../spaces/spaces.js';
import { isSsrfSafeUrl } from '../util/ssrf.js';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import type { SchemaLibraryEntry, SchemaCatalog } from '../config/types.js';

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

/** Zod schema for a PropertySchema (matches spaces.ts PropertySchemaZ). */
const PropertySchemaZ = z.object({
  type: z.enum(['string', 'number', 'boolean', 'date']).optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  pattern: z.string().max(500).optional(),
  mergeFn: z.enum(['avg', 'min', 'max', 'sum', 'and', 'or', 'xor']).optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict().refine(data => {
  if (!data.mergeFn) return true;
  const numericFns = new Set(['avg', 'min', 'max', 'sum']);
  const booleanFns = new Set(['and', 'or', 'xor']);
  if (data.type === 'number') return numericFns.has(data.mergeFn);
  if (data.type === 'boolean') return booleanFns.has(data.mergeFn);
  if (data.type === 'string' || data.type === 'date') return false;
  return numericFns.has(data.mergeFn) || booleanFns.has(data.mergeFn);
}, {
  message: 'mergeFn is incompatible with the declared type (numeric fns require type "number", boolean fns require type "boolean")',
});

/** Zod schema for the inline TypeSchema stored in library entries.
 *  `$ref` is not permitted inside a library entry (no recursive references). */
const LibraryTypeSchemaZ = z.object({
  namingPattern: z.string().max(500).optional(),
  tagSuggestions: z.array(z.string().min(1).max(200)).max(200).optional(),
  propertySchemas: z.record(z.string().min(1).max(200), PropertySchemaZ).optional(),
}).strict();

/** Name must be URL-safe and reasonably short. Allows uppercase, dots, dashes, underscores. */
const LIBRARY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;

const LibraryEntryBodyZ = z.object({
  name: z.string().min(1).max(200).regex(LIBRARY_NAME_RE, 'name must start with an alphanumeric character and contain only letters, digits, dots, dashes, or underscores'),
  knowledgeType: z.enum(['entity', 'memory', 'edge', 'chrono']),
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
  knowledgeType: z.enum(['entity', 'memory', 'edge', 'chrono']),
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
  const kts = ['entity', 'memory', 'edge', 'chrono'] as const;
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
    res.json({ entry: updatedEntry });
  }
});

// ── GET /:name/usages — list all spaces that $ref this library entry ─────────

schemaLibraryRouter.get('/:name/usages', globalRateLimit, requireAuth, (req, res) => {
  const name = req.params['name'] as string;
  const refValue = `library:${name}`;
  const kts = ['entity', 'memory', 'edge', 'chrono'] as const;

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
    const resp = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    const body = await resp.json().catch(() => null);
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
