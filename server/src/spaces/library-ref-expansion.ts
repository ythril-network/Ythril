/**
 * How a schema-library type is SHOWN — its reference and its definition side by side — and how that shape is TAKEN
 * BACK, so a round trip never cuts a type loose from its library entry (`Q-168`, owner ruling D-6).
 *
 * ## Why this exists
 *
 * A space type may be declared `{ "$ref": "library:<name>" }`: its definition lives in the instance's schema library.
 * The two doors used to answer the meta with two different documents — REST the stored `{ $ref }` unless asked
 * `?resolve=1`, MCP always the library entry's definition IN PLACE of the reference. Each lost something: the REST
 * reader could not see the type's fields, the agent could not see that the type was linked, and neither answer could
 * be written back whole. The resolved one was worse than refused — `schema_update` accepted it and stored the
 * definition inline, silently detaching the type from its entry, so a later library edit no longer reached it.
 *
 * The owner's ruling: *"as always one module 2 doors... most capable and least destructive and least breaking"*.
 *
 *   - **Most capable** — {@link withLibraryDefinitions}: by default a library type reads as `{ $ref, ...definition }`.
 *     The definition's keys are a `TypeSchema`'s own (`description`, `propertySchemas`, …) and a library entry may not
 *     nest a `$ref` (`LibraryTypeSchemaZ`), so nothing collides: a reader of `$ref` and a reader of `propertySchemas`
 *     both find what they read today. A reference this instance cannot resolve reads `{ $ref, _unresolvedRef }`, the
 *     mark the validator already uses, so a broken link is visible rather than an empty type.
 *   - **Least destructive** — {@link takeBackLibraryDefinition}: every write of a type schema goes through
 *     `TypeSchemaZ` (`body-schemas.ts`), and this runs first there. Beside a `$ref`, the definition is SERVER-OWNED:
 *     identical to the entry's, it is dropped and `{ $ref }` is stored. Before `.strict()`, because the strict union
 *     is exactly what refused the round trip.
 *   - **Refusal over silent loss** — a definition beside a `$ref` that DIFFERS from the entry's is an edit that would
 *     vanish, since the type's definition is the entry. It is a 400 naming the fields and the two ways to make the
 *     edit: change the library entry, or drop the `$ref` and define the type inline. (It also fires when the entry
 *     itself changed since the caller read it — the message says so, because both mean the body is stale.)
 *
 * ## One question
 *
 * *"What does a library-referenced type look like on the wire, in each direction."* Validation's inline replacement
 * (`resolveMetaRefs`) and the peer-bound inlining (`inlineResolvableRefs`) answer other questions and stay where they
 * are.
 */
import { z } from 'zod';
import { getSchemaLibrary } from '../config/loader.js';
import type { SpaceMeta, TypeSchema } from '../config/types.js';

/** The library entry's definition for a `library:<name>` reference, or undefined when there is none. */
function definitionOf(ref: string): Record<string, unknown> | undefined {
  if (!ref.startsWith('library:')) return undefined;
  const name = ref.slice('library:'.length);
  return getSchemaLibrary().find(e => e.name === name)?.schema as Record<string, unknown> | undefined;
}

/** JSON with keys sorted, so two definitions that differ only in key order compare equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * The meta with each library type shown as `{ $ref, ...definition }` — the default answer on both doors.
 * Types without a `$ref` are returned as they are. Never mutates `meta`.
 */
export function withLibraryDefinitions(meta: SpaceMeta): SpaceMeta {
  if (!meta.typeSchemas) return meta;
  let changed = false;
  const typeSchemas: Record<string, Record<string, TypeSchema>> = {};
  for (const [kt, types] of Object.entries(meta.typeSchemas) as [string, Record<string, TypeSchema>][]) {
    const out: Record<string, TypeSchema> = {};
    for (const [name, schema] of Object.entries(types ?? {})) {
      if (schema?.$ref) {
        const def = definitionOf(schema.$ref);
        out[name] = (def ? { $ref: schema.$ref, ...structuredClone(def) } : { $ref: schema.$ref, _unresolvedRef: schema.$ref }) as TypeSchema;
        changed = true;
      } else {
        out[name] = schema;
      }
    }
    typeSchemas[kt] = out;
  }
  return changed ? { ...meta, typeSchemas: typeSchemas as SpaceMeta['typeSchemas'] } : meta;
}

/**
 * `TypeSchemaZ`'s preprocess: a type carrying `$ref` beside other keys is taken back to `{ $ref }` when those keys are
 * the entry's definition (or the unresolved mark), and refused, naming them, when they are not.
 *
 * Anything that is not an object with a string `$ref` and more keys passes through untouched, for the union to judge.
 */
export function takeBackLibraryDefinition(
  value: unknown,
  ctx: { addIssue(issue: { code: 'custom'; message: string; input?: unknown }): void },
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  // `_unresolvedRef` is left out of the comparison below: it is a mark the server writes, never the caller's.
  const { $ref, _unresolvedRef: _mark, ...rest } = value as Record<string, unknown>;
  if (typeof $ref !== 'string') return value;
  if (Object.keys(rest).length === 0) return { $ref };

  const def = definitionOf($ref);
  if (def && canonical(rest) === canonical(def)) return { $ref };

  const fields = def
    ? [...new Set([...Object.keys(rest), ...Object.keys(def)])].filter(k => canonical(rest[k]) !== canonical(def[k]))
    : Object.keys(rest);
  const entry = $ref.startsWith('library:') ? $ref.slice('library:'.length) : $ref;
  ctx.addIssue({
    code: 'custom',
    input: value,
    message: `${fields.map(f => `\`${f}\``).join(', ')} beside \`$ref: ${$ref}\` ${def ? 'differs from' : 'cannot be checked against'} `
      + `the schema library entry '${entry}'${def ? ' as it is now' : ', which does not exist'}. A library type's definition IS the `
      + `library entry, so this edit would be lost: change the entry (PUT /api/schema-library/${entry}), or drop \`$ref\` to `
      + 'define the type inline. Sending back what the meta returned is always accepted — if you did not edit this type, '
      + 'the library entry changed since you read it; read the meta again.',
  });
  // Stop here: the union below would otherwise add "unrecognized keys" beside the one refusal that says why.
  return z.NEVER;
}
