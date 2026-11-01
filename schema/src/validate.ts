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
 * It is DRY: it stores nothing, reads no config, and answers what `parseSpaceMeta` answers, plus the two library refusals.
 */
import { withSchemaLibrary, currentSchemaLibrary, type SchemaLibraryEntryLike } from './library.js';
import {
  parseSpaceMeta, findBrokenLibraryRefs, brokenRefsError, findWrongKindLibraryRefs, wrongKindRefsError, type MetaParse, TypeSchemasZ,
} from './space-meta.js';
import type { z } from 'zod';

/** How {@link validateSpaceMeta} reads. */
export interface ValidateSpaceMetaOptions {
  /**
   * The schema-library entries the meta's `$ref`s may name. Given, each `$ref` must name one of them, filed under the kind the type is
   * filed under, and a `{ $ref, ...definition }` round trip is compared with it. Absent, the installed library is read — none, in an
   * app — and a `$ref` naming an entry is refused as one that does not exist.
   */
  library?: readonly SchemaLibraryEntryLike[];
  /** Read the meta as a peer's: name the keys this release does not know instead of refusing them. Off for an app's own schema. */
  tolerant?: boolean;
}

/**
 * Whether `meta` is a space meta Ythril would store: `{ ok: true, meta, unknown }` with the parsed meta, or `{ ok: false, message,
 * failed }` with the refusal the server would give (`failed` names each failing part, `kind:Type — reason`).
 */
export function validateSpaceMeta(meta: unknown, options: ValidateSpaceMetaOptions = {}): MetaParse {
  const library = options.library ?? currentSchemaLibrary();
  return withSchemaLibrary(library, () => {
    const parsed = parseSpaceMeta(meta, { tolerant: options.tolerant === true });
    if (!parsed.ok) return parsed;
    const typeSchemas = parsed.meta.typeSchemas as z.infer<typeof TypeSchemasZ> | undefined;
    const broken = findBrokenLibraryRefs(typeSchemas, library);
    if (broken.length > 0) return { ok: false, message: brokenRefsError(broken), failed: broken.map(name => `$ref — ${name}`) };
    const wrong = findWrongKindLibraryRefs(typeSchemas, library);
    if (wrong.length > 0) return { ok: false, message: wrongKindRefsError(wrong), failed: wrong.map(w => `${w.kind}:${w.type} — $ref`) };
    return parsed;
  });
}
