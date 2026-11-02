/**
 * The one call an app makes to ask "would Ythril store this space meta?" — offline, with no instance, and with the server's own words.
 *
 * ## What it prevents
 *
 * An app that writes a schema (a space template, a generator, a flow) learned whether it was valid only when an instance answered
 * 400 — at deploy time, on a live space. A hand-made mirror of the validator in the app's own repository drifts from the server on the
 * first change to either, and nothing in either repository can see the drift. This runs the server's parse, unchanged: the same bodies,
 * the same CEL rule checks, the same refusal text, and — when the app hands in the library entries it references — the same `$ref`
 * checks the server makes before it stores a meta (an entry that does not exist, an entry filed under another kind).
 *
 * It is DRY: it stores nothing, reads no config, and answers what `parseSpaceMeta` answers, plus the two library refusals — which are
 * {@link libraryRefRefusal}, the one `$ref` refusal every Ythril door that stores or dry-runs a schema calls.
 */
import { withSchemaLibrary, currentSchemaLibrary, type SchemaLibraryEntryLike } from './library.js';
import {
  parseSpaceMeta, findBrokenLibraryRefs, brokenRefsError, findWrongKindLibraryRefs, wrongKindRefsError, type MetaParse, TypeSchemasZ,
} from './space-meta.js';
import type { z } from 'zod';

/**
 * The `$ref` refusal: whether `typeSchemas` references a library entry that does not exist, or one filed under another kind than the
 * type that references it — `{ message, failed }` with the refusal Ythril answers (at 422), or `null` when every reference holds.
 * Broken references are asked first: a missing entry has no kind to compare.
 *
 * ## What it prevents
 *
 * The sequence — find the broken refs, say so; find the wrong-kind refs, say so — was written at five doors, two of them with the
 * sentence typed out by hand, and one door that claimed to refuse what a save refuses did not run it at all. It is written here once;
 * the finders and their wording are package-internal, so a door cannot assemble a sixth copy from them.
 *
 * `library` is the entries the references are read against; absent, the library a parse would read now (scoped, else installed — and
 * with neither, the read throws "no schema library installed").
 */
export function libraryRefRefusal(
  typeSchemas: z.infer<typeof TypeSchemasZ> | Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>> | undefined,
  library?: readonly SchemaLibraryEntryLike[],
): { message: string; failed: string[] } | null {
  if (!typeSchemas) return null;
  const entries = library ?? currentSchemaLibrary();
  const map = typeSchemas as z.infer<typeof TypeSchemasZ>;
  const broken = findBrokenLibraryRefs(map, entries);
  if (broken.length > 0) return { message: brokenRefsError(broken), failed: broken.map(name => `$ref — ${name}`) };
  const wrong = findWrongKindLibraryRefs(map, entries);
  if (wrong.length > 0) return { message: wrongKindRefsError(wrong), failed: wrong.map(w => `${w.kind}:${w.type} — $ref`) };
  return null;
}

/** How {@link validateSpaceMeta} reads. */
export interface ValidateSpaceMetaOptions {
  /**
   * The schema-library entries the meta's `$ref`s may name. Given, each `$ref` must name one of them, filed under the kind the type is
   * filed under, and a `{ $ref, ...definition }` round trip is compared with it. Absent, the library is EMPTY (`[]`), never the
   * installed one: a `$ref` naming an entry is refused as one that does not exist, and this call never meets the "no schema library
   * installed" throw a direct parse outside `withSchemaLibrary` does.
   */
  library?: readonly SchemaLibraryEntryLike[];
  /**
   * Read the meta as a peer's: name the keys this release does not know in the answer's `unknown` instead of refusing them. Off for an
   * app's own schema, where an unknown key is a typo the server would refuse.
   */
  tolerant?: boolean;
}

/**
 * Whether `meta` is a space meta Ythril would store: `{ ok: true, meta, unknown }` with the parsed meta, or `{ ok: false, message,
 * failed }` with the refusal the server would give (`failed` names each failing part, `kind:Type — reason`).
 */
export function validateSpaceMeta(meta: unknown, options: ValidateSpaceMetaOptions = {}): MetaParse {
  const library = options.library ?? [];
  return withSchemaLibrary(library, () => {
    const parsed = parseSpaceMeta(meta, { tolerant: options.tolerant === true });
    if (!parsed.ok) return parsed;
    const refusal = libraryRefRefusal(parsed.meta.typeSchemas as z.infer<typeof TypeSchemasZ> | undefined, library);
    return refusal ? { ok: false, ...refusal } : parsed;
  });
}
