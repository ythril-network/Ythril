/**
 * Schema changes, recorded as a SUMMARY of names — never as values.
 *
 * `audit-changes.ts` records scalars from an allowlist of field names, and drops objects and arrays
 * outright so that one allowlisted parent cannot silently ship every child it later gains. That is the
 * right default and it is not relaxed here. But it left a real hole: `space.schema.update` and
 * `schema_library.update` change **nested objects**, so every one of them recorded nothing at all. The
 * audit log said "an admin replaced the schema" and could not say whether they added a type or deleted
 * eleven — which is precisely the question an audit log exists to answer, and the schema is the thing
 * that decides what the whole space will accept from then on.
 *
 * ── What is recorded, and why that is safe ───────────────────────────────────────────────────────────
 *
 * **Names only.** Type names and property KEYS; never a property's schema, never a default, never an
 * enum member, never a naming pattern. A default or an enum can be example data pulled from real
 * records; a key is the declared vocabulary an admin chose. This is the same line the record-edit
 * allowlist draws when it records `tags` but refuses `properties`.
 *
 * The output reuses `AuditChange`'s existing `added`/`removed` set shape rather than inventing one.
 * That is not just convenience: it means the reader, the retention sweep and the API contract need no
 * new case, and there is no second value-carrying shape for a future field to leak through.
 *
 * ── Fail closed ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Anything that is not a plain object where an object is expected yields no entry for that level. A
 * malformed snapshot records nothing rather than guessing, exactly as `scalarOrDrop` does.
 */
import type { AuditChange } from './audit-changes.js';
import { KNOWLEDGE_TYPES } from '../config/types.js';

/** The four knowledge collections a space's `typeSchemas` can describe. */
// Imported rather than listed: a fifth kind must appear in an audit summary without anyone remembering to
// add it here, because a kind silently missing from a summary is a summary nobody can tell is incomplete.

/** Property keys reported per type before the list is truncated. Keeps one paste-of-a-huge-schema from
 *  writing thousands of names into a retained store; the count still tells the reader it happened. */
export const MAX_KEYS_PER_FIELD = 25;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** Set difference over object keys, capped. Returns null when nothing changed. */
function keyDelta(before: unknown, after: unknown): { added: string[]; removed: string[] } | null {
  const b = asRecord(before) ?? {};
  const a = asRecord(after) ?? {};
  const bKeys = new Set(Object.keys(b));
  const aKeys = new Set(Object.keys(a));
  const added = [...aKeys].filter(k => !bKeys.has(k));
  const removed = [...bKeys].filter(k => !aKeys.has(k));
  if (!added.length && !removed.length) return null;
  return { added: added.slice(0, MAX_KEYS_PER_FIELD), removed: removed.slice(0, MAX_KEYS_PER_FIELD) };
}

function push(out: AuditChange[], field: string, delta: { added: string[]; removed: string[] } | null): void {
  if (!delta) return;
  out.push({
    field,
    ...(delta.added.length ? { added: delta.added } : {}),
    ...(delta.removed.length ? { removed: delta.removed } : {}),
  });
}

/**
 * Summarise a change to one `typeSchemas` map (the shape under `meta.typeSchemas`).
 *
 * Two levels, both name-only:
 *   - `typeSchemas.<kind>` — which type names appeared or disappeared;
 *   - `typeSchemas.<kind>.<type>.propertySchemas` — which property keys appeared or disappeared, for a
 *     type that exists on **both** sides. A type that was just added or removed is not also reported
 *     property-by-property: the first line already said the whole type arrived or left, and repeating
 *     its fields would bury the change that matters under the change that is implied by it.
 */
export function summariseTypeSchemas(before: unknown, after: unknown): AuditChange[] {
  const out: AuditChange[] = [];
  const b = asRecord(before) ?? {};
  const a = asRecord(after) ?? {};

  for (const kind of KNOWLEDGE_TYPES) {
    const bKind = asRecord(b[kind]);
    const aKind = asRecord(a[kind]);
    if (!bKind && !aKind) continue;

    push(out, `typeSchemas.${kind}`, keyDelta(bKind, aKind));

    // Property-key changes, only for types present on both sides.
    for (const typeName of Object.keys(aKind ?? {})) {
      if (!bKind || !(typeName in bKind)) continue;
      const bProps = asRecord(bKind[typeName])?.['propertySchemas'];
      const aProps = asRecord((aKind ?? {})[typeName])?.['propertySchemas'];
      push(out, `typeSchemas.${kind}.${typeName}.propertySchemas`, keyDelta(bProps, aProps));
    }
  }

  return out;
}

/**
 * Summarise a change to one schema-library entry.
 *
 * The library entry holds a single `schema` (a `TypeSchema`), so the interesting delta is its property
 * keys plus the scalar metadata the ordinary allowlist can already carry. Only the keys are produced
 * here; `knowledgeType`/`typeName`/`published` go through `AUDIT_CHANGE_FIELDS` as normal scalars.
 */
export function summariseLibraryEntry(before: unknown, after: unknown): AuditChange[] {
  const out: AuditChange[] = [];
  const bProps = asRecord(asRecord(before)?.['schema'])?.['propertySchemas'];
  const aProps = asRecord(asRecord(after)?.['schema'])?.['propertySchemas'];
  push(out, 'schema.propertySchemas', keyDelta(bProps, aProps));
  return out;
}

/**
 * Which operations get a summary, and how to derive it.
 *
 * An operation absent here summarises nothing — the same silent-by-default rule the field allowlist
 * follows, for the same reason: a route added later must not start recording structure nobody vetted.
 */
export const AUDIT_SCHEMA_SUMMARY: Readonly<Record<string, (before: unknown, after: unknown) => AuditChange[]>> = {
  'space.schema.update': (before, after) =>
    summariseTypeSchemas(asRecord(before)?.['typeSchemas'], asRecord(after)?.['typeSchemas']),
  'schema_library.update': summariseLibraryEntry,
};
