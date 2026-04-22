/**
 * Instance-level schema library CRUD API.
 *
 * Provides reusable TypeSchema definitions that spaces can reference via
 * `$ref: "library:<name>"` in their typeSchemas instead of duplicating
 * schema definitions inline.
 *
 * Routes:
 *   GET    /api/schema-library          — list all entries
 *   GET    /api/schema-library/:name    — get a single entry
 *   POST   /api/schema-library          — create a new entry
 *   PUT    /api/schema-library/:name    — create or replace an entry
 *   DELETE /api/schema-library/:name    — remove an entry
 */

import { Router } from 'express';
import { requireAuth, requireAdminMfa } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getSchemaLibrary, saveSchemaLibrary } from '../config/loader.js';
import { z } from 'zod';
import type { SchemaLibraryEntry } from '../config/types.js';

export const schemaLibraryRouter = Router();

// ── Validation ─────────────────────────────────────────────────────────────

const VALID_KNOWLEDGE_TYPES = new Set(['entity', 'memory', 'edge', 'chrono']);
const MAX_LIBRARY_ENTRIES = 500;

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

/** Name must be URL-safe and reasonably short. */
const LIBRARY_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,199}$/;

const LibraryEntryBodyZ = z.object({
  name: z.string().min(1).max(200).regex(LIBRARY_NAME_RE, 'name must be lowercase alphanumeric with optional dashes/underscores, starting with a lowercase letter or digit'),
  knowledgeType: z.enum(['entity', 'memory', 'edge', 'chrono']),
  typeName: z.string().min(1).max(200),
  schema: LibraryTypeSchemaZ,
  description: z.string().max(1000).optional(),
});

/** Body for PUT (name comes from the URL param). */
const LibraryEntryPutBodyZ = z.object({
  knowledgeType: z.enum(['entity', 'memory', 'edge', 'chrono']),
  typeName: z.string().min(1).max(200),
  schema: LibraryTypeSchemaZ,
  description: z.string().max(1000).optional(),
});

// ── GET / — list all library entries ──────────────────────────────────────

schemaLibraryRouter.get('/', globalRateLimit, requireAuth, (_req, res) => {
  res.json({ entries: getSchemaLibrary() });
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

  const { name, knowledgeType, typeName, schema, description } = parsed.data;
  const library = getSchemaLibrary();

  if (library.some(e => e.name === name)) {
    res.status(409).json({ error: `Schema library entry '${name}' already exists. Use PUT to update it.` });
    return;
  }

  if (library.length >= MAX_LIBRARY_ENTRIES) {
    res.status(400).json({ error: `Maximum of ${MAX_LIBRARY_ENTRIES} library entries reached. Remove unused entries before adding new ones.` });
    return;
  }

  if (!VALID_KNOWLEDGE_TYPES.has(knowledgeType)) {
    res.status(400).json({ error: `Invalid knowledgeType '${knowledgeType}'.` });
    return;
  }

  const now = new Date().toISOString();
  const entry: SchemaLibraryEntry = {
    name,
    knowledgeType,
    typeName,
    schema,
    ...(description ? { description } : {}),
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

  const { knowledgeType, typeName, schema, description } = parsed.data;

  if (!VALID_KNOWLEDGE_TYPES.has(knowledgeType)) {
    res.status(400).json({ error: `Invalid knowledgeType '${knowledgeType}'.` });
    return;
  }

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
      description: description ?? existing.description,
      updatedAt: now,
    };
    const updatedLibrary = [...library];
    updatedLibrary[existingIdx] = updatedEntry;
    saveSchemaLibrary(updatedLibrary);
    res.json({ entry: updatedEntry });
  }
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
