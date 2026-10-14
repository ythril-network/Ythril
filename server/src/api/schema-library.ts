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

import { voteOnSchemaEditIfNetworked } from '../spaces/meta-update.js';
import { commitOwnMetaEdit } from '../spaces/effective-meta.js';
import { Router } from 'express';
import { isDeepStrictEqual } from 'node:util';
import { boundedJson } from '../util/bounded-read.js';
import { requireAuth, requireAdminMfa, acceptSchemaLibraryToken } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getSchemaLibrary, saveSchemaLibrary, getConfig, getSchemaCatalogs, saveSchemaCatalogs } from '../config/loader.js';
import { isSsrfSafeUrl, ssrfSafeFetch } from '../util/ssrf.js';
import { z } from 'zod';
import {
  InlineTypeSchemaZ, LIBRARY_SCHEMA_KEYS, libraryDeletePathProblem, parseInlineDefinition, withTypeSchemas,
} from '../spaces/body-schemas.js';
import rateLimit from 'express-rate-limit';
import type { SchemaLibraryEntry, SchemaCatalog, KnowledgeType } from '../config/types.js';
import { KNOWLEDGE_TYPES } from '../config/types.js';
import { libraryUsages } from '../spaces/library-usages.js';
import { applyDeleteFields, validateDeleteFields } from '../brain/delete-fields.js';
import { peerText, peerList, refusalOfParse } from '../util/log.js';

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

/**
 * Zod schema for the inline TypeSchema stored in library entries.
 *
 * It is the INLINE type definition and nothing else different (`Q-215`): the keys are READ OUT of the inline branch of `TypeSchemaZ`
 * (`spaces/body-schemas.ts`), never restated here. This file used to carry a hand-built copy "kept in step by a comment", and the copy
 * drifted: it lacked `description` and `whenDuePasses`, accepted a ReDoS naming pattern, knew nothing of the collection an entry is
 * filed under, and its PATCH merged two keys of the eight it accepted. The property grammar, the pattern rule and the endpoints
 * grammar are the inline body's own, so a value one door accepts and the other refuses cannot arise from here.
 *
 * `$ref` is not permitted inside a library entry (no recursive references).
 *
 * ## `retention` is refused ON PURPOSE, and says so
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
  ...InlineTypeSchemaZ.shape,
  retention: z.never({
    message: 'retention cannot be set on a schema-library entry: one entry is referenced by any number of spaces, '
      + 'and a delete window belongs to a type in a space rather than to the shape. Set it on the type after '
      + 'resolving the $ref to an inline definition, or use the space-wide recordTtlDays.',
  }).optional(),
}).strict();

/** One entry's schema, parsed with the collection the entry is filed under — what every door of the library stores. */
const parseLibraryEntrySchema = (kind: KnowledgeType, schema: unknown) => parseInlineDefinition(LibraryTypeSchemaZ, kind, schema);

/** Name must be URL-safe and reasonably short. Allows uppercase, dots, dashes, underscores. */
const LIBRARY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;

/** What a 400 for a name the pattern refuses says — read from the pattern's own meaning, never a second statement of it. */
const LIBRARY_NAME_REFUSAL = 'Invalid library entry name. It must start with a letter or a digit and contain only letters, digits, dots, dashes and underscores (200 characters at most).';

/**
 * Why an entry cannot be filed under another kind, or `undefined` when it can: a space that references it as a type of its OWN kind
 * would, after the change, take fields that only mean something on another collection (`Q-215`). Named by space, so the operator knows
 * which reference to move first.
 */
function kindChangeRefusal(name: string, newKind: KnowledgeType): string | undefined {
  const holding = (libraryUsages(getConfig().spaces).get(name) ?? []).filter(u => u.knowledgeType !== newKind);
  if (holding.length === 0) return undefined;
  const spaces = [...new Set(holding.map(u => u.spaceId))];
  return `Library entry '${name}' is referenced as a ${holding[0]!.knowledgeType} type by ${peerList(spaces, ', ')} and cannot be filed under ${newKind}: `
    + 'those spaces would run fields that only mean something on another collection. Move the references first.';
}

export const LibraryEntryBodyZ = z.object({
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
export const LibraryEntryPutBodyZ = z.object({
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
export const LibraryEntryPatchBodyZ = z.object({
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
export const PublishPatchZ = z.object({
  published: z.boolean(),
});

/** Body for POST /catalogs */
const CATALOG_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
export const CatalogBodyZ = z.object({
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
  // `usageCounts` beside the entries rather than on them: an entry is also what a client sends back on a write,
  // and a derived count on it would be a field the write has to refuse or strip (Q-112).
  const used = libraryUsages(getConfig().spaces);
  const entries = getSchemaLibrary();
  res.json({ entries, usageCounts: Object.fromEntries(entries.map(e => [e.name, used.get(e.name)?.length ?? 0])) });
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

export const ExportSpaceBodyZ = z.object({
  spaceId: z.string().min(1).max(200),
  groupName: z.string().min(1).max(200),
  namePrefix: z.string().min(1).max(200).optional(),
});

schemaLibraryRouter.post('/export-space', globalRateLimit, requireAdminMfa, (req, res) => {
  const parsed = ExportSpaceBodyZ.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(refusalOfParse(parsed.error));
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
  // What the export left out or changed, and why (`Q-215`): a space can hold a schema stored before a rule existed (config.json, an
  // import, a peer), and exporting it must not launder it into the library — where every space that references the entry would run
  // the pattern — nor carry a `retention` window the library refuses on every other door.
  const skipped: { type: string; reason: string }[] = [];
  const retentionDropped: string[] = [];

  for (const kt of kts) {
    const ktMap = typeSchemas[kt];
    if (!ktMap) continue;
    for (const [typeName, schema] of Object.entries(ktMap)) {
      // Skip $ref entries — they already point at a library entry
      if ('$ref' in schema) continue;

      // The library's own parse of what would be stored: `retention` is taken off (a window belongs to a type in a space, never to a shape)
      // and said so; a type the library would refuse is left out, naming it and why.
      const { retention, ...withoutRetention } = schema as Record<string, unknown>;
      const checked = parseLibraryEntrySchema(kt, withoutRetention);
      if (!checked.ok) {
        skipped.push({ type: `${kt}:${peerText(typeName, { max: 200 })}`, reason: peerText(checked.message, { max: 300 }) });
        continue;
      }
      if (retention !== undefined) retentionDropped.push(`${kt}:${peerText(typeName, { max: 200 })}`);

      const safeName = typeName.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 80);
      const entryName = `${prefix}-${kt}-${safeName}`.slice(0, 200);

      const existingIdx = library.findIndex(e => e.name === entryName);

      // Inline schema (no $ref), as the library parses it.
      const inlineSchema: SchemaLibraryEntry['schema'] = checked.schema;

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
  res.json({
    created, updated, entries: resultEntries,
    ...(skipped.length ? { skipped } : {}),
    ...(retentionDropped.length ? { retentionDropped, retentionNote: 'a retention window belongs to a type in a space, not to a library entry: it was left out of these entries' } : {}),
  });
});

// ── POST /groups/:group/apply — apply all entries in a group to a space ───
//
//  Body: { spaceId: string }
//  Creates `$ref: "library:<name>"` entries in the target space's typeSchemas
//  for every library entry that belongs to the specified group.
//  Existing type definitions for matching names are overwritten.

export const ApplyGroupBodyZ = z.object({
  spaceId: z.string().min(1).max(200),
});

schemaLibraryRouter.post('/groups/:group/apply', globalRateLimit, requireAdminMfa, async (req, res) => {
  const group = req.params['group'] as string;
  const parsed = ApplyGroupBodyZ.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(refusalOfParse(parsed.error));
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

  // Through the own definitions (F-39.2): the group's references land in what this instance defines, so a space
  // whose meta is rebuilt from network layers keeps them.
  // Q-52: a networked space's schema is the network's to decide, as on PATCH — this answers 202 with the round.
  const voted = await voteOnSchemaEditIfNetworked(spaceId, typeSchemas, 'replace');
  if (voted) { res.status(voted.status).json(voted.body); return; }
  const updated = commitOwnMetaEdit(spaceId, base => {
    const own = { ...base.typeSchemas };
    for (const a of applied) own[a.knowledgeType as keyof typeof own] = { ...(own[a.knowledgeType as keyof typeof own] ?? {}), [a.typeName]: { $ref: `library:${a.entryName}` } };
    // Parsed like every other write of a type schema: the map is the own definitions' types and `$ref`s to entries of the right kind.
    return withTypeSchemas(base, own);
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
    res.status(400).json(refusalOfParse(parsed.error));
    return;
  }

  const { name, knowledgeType, typeName, schema: bodySchema, description, schemaGroup, published, sourceUrl, sourceCatalog } = parsed.data;
  const library = getSchemaLibrary();

  if (library.some(e => e.name === name)) {
    res.status(409).json({ error: `Schema library entry '${name}' already exists. Use PUT to update it.` });
    return;
  }

  if (library.length >= MAX_LIBRARY_ENTRIES) {
    res.status(400).json({ error: `Maximum of ${MAX_LIBRARY_ENTRIES} library entries reached. Remove unused entries before adding new ones.` });
    return;
  }

  // The same refusals the inline doors make, with the collection the entry is filed under (`Q-215`).
  const checked = parseLibraryEntrySchema(knowledgeType, bodySchema);
  if (!checked.ok) {
    res.status(400).json({ error: checked.message });
    return;
  }
  const schema = checked.schema;

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
    res.status(400).json({ error: LIBRARY_NAME_REFUSAL });
    return;
  }

  const parsed = LibraryEntryPutBodyZ.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(refusalOfParse(parsed.error));
    return;
  }

  const { knowledgeType, typeName, schema: bodySchema, description, schemaGroup, published, sourceUrl, sourceCatalog } = parsed.data;

  const library = getSchemaLibrary();
  const existingIdx = library.findIndex(e => e.name === name);

  if (existingIdx === -1 && library.length >= MAX_LIBRARY_ENTRIES) {
    res.status(400).json({ error: `Maximum of ${MAX_LIBRARY_ENTRIES} library entries reached. Remove unused entries before adding new ones.` });
    return;
  }

  // The same refusals the inline doors make, with the collection the entry is filed under (`Q-215`).
  const checked = parseLibraryEntrySchema(knowledgeType, bodySchema);
  if (!checked.ok) {
    res.status(400).json({ error: checked.message });
    return;
  }
  const schema = checked.schema;
  const stranded = existingIdx === -1 ? undefined : kindChangeRefusal(name, knowledgeType);
  if (stranded) {
    res.status(409).json({ error: stranded });
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
    res.status(400).json({ error: LIBRARY_NAME_REFUSAL });
    return;
  }

  const parsed = LibraryEntryPatchBodyZ.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(refusalOfParse(parsed.error));
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

  // Merge the schema BY THE KEYS THE BODY ACCEPTS, not by a list kept beside it (`Q-215`): this merged two keys of the eight the body
  // took, so `suppressEmbeddings`, `endpoints` and `functional` were ACCEPTED and then DROPPED — a 200 for an entry that had not
  // changed. A key named replaces what the entry held; `propertySchemas` is the one map that is added to, a named property replacing
  // its namesake and every unnamed one surviving.
  const mergedSchema: Record<string, unknown> = { ...(existing.schema ?? {}) };
  for (const [key, value] of Object.entries(patch.schema ?? {})) {
    if (value === undefined) continue;
    mergedSchema[key] = key === 'propertySchemas'
      ? { ...(existing.schema?.propertySchemas ?? {}), ...(value as Record<string, unknown>) }
      : value;
  }

  // Removals, applied AFTER the merge so a single request can replace one property and drop another without
  // the order mattering to the caller. Any path inside the schema is deletable, by the one deleter the record routes use; a path that
  // names nothing a schema has is refused naming it, not ignored — a typo'd path that is silently dropped leaves the caller believing
  // a property was removed when it is still validating records.
  const deletable = validateDeleteFields(patch.deleteFields);
  if (!deletable.ok) {
    res.status(400).json({ error: deletable.error });
    return;
  }
  const unknownPaths = (patch.deleteFields ?? []).filter(p => libraryDeletePathProblem(p) !== undefined);
  if (unknownPaths.length > 0) {
    res.status(400).json({
      error: `deleteFields paths must start with a key of the schema (${LIBRARY_SCHEMA_KEYS.join(', ')}) — unrecognised: ${peerList(unknownPaths, ', ', { each: 120 })}`,
    });
    return;
  }
  if (patch.deleteFields?.length) {
    applyDeleteFields(mergedSchema, patch.deleteFields);
    // `endpoints` with neither end names no constraint and is refused by the body: taking out its last end takes the whole key out.
    const ends = mergedSchema['endpoints'];
    if (ends && typeof ends === 'object' && Object.keys(ends).length === 0) delete mergedSchema['endpoints'];
  }

  // The result is what the entry becomes, so it is what is checked: the collection the entry will be filed under is the one in the
  // patch, or the one it has.
  // A patch that changes neither the schema nor the kind is not answerable for what the entry already holds (one stored before a rule
  // existed): the schema is checked when the write changes it.
  const finalKind: KnowledgeType = patch.knowledgeType ?? existing.knowledgeType;
  const schemaChanged = !isDeepStrictEqual(mergedSchema, existing.schema ?? {}) || finalKind !== existing.knowledgeType;
  let nextSchema = existing.schema;
  if (schemaChanged) {
    const checked = parseLibraryEntrySchema(finalKind, mergedSchema);
    if (!checked.ok) {
      res.status(400).json({ error: checked.message });
      return;
    }
    nextSchema = checked.schema;
  }
  const stranded = finalKind !== existing.knowledgeType ? kindChangeRefusal(name, finalKind) : undefined;
  if (stranded) {
    res.status(409).json({ error: stranded });
    return;
  }

  const now = new Date().toISOString();
  const updated: SchemaLibraryEntry = {
    ...existing,
    ...(patch.knowledgeType !== undefined ? { knowledgeType: patch.knowledgeType } : {}),
    ...(patch.typeName !== undefined ? { typeName: patch.typeName } : {}),
    schema: nextSchema,
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
  // The same function the list's `usageCounts` comes from, so the two cannot disagree (Q-112).
  res.json({ usages: libraryUsages(getConfig().spaces).get(name) ?? [] });
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
    res.status(400).json(refusalOfParse(parsed.error));
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
    res.status(400).json(refusalOfParse(parsed.error));
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
