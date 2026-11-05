/**
 * The schema library a type's `$ref` names, as this package sees it: never read from an instance's config, always HANDED in.
 *
 * ## Why it is handed in
 *
 * A type may be declared `{ "$ref": "library:<name>" }`, its definition living in the instance's schema library. The body every schema
 * write parses through (`TypeSchemaZ`) takes a round-tripped `{ $ref, ...definition }` back to `{ $ref }` when the definition is the
 * entry's, and refuses it when it was edited ({@link takeBackLibraryDefinition}, `Q-168`). That needs the entry — and an app validating
 * a schema offline has no instance to read it from. So the library is a parameter:
 *
 *  - **an app** passes the entries it knows to `validateSpaceMeta(meta, { library })` (with none, `validateSpaceMeta` reads `[]`, and
 *    a `$ref` is refused as naming an entry that does not exist), or wraps any direct parse in {@link withSchemaLibrary};
 *  - **the server** installs its own library once ({@link useSchemaLibrary}, exported by `@ythril-network/schema/internal` and called in
 *    `server/src/spaces/library-ref-expansion.ts`), read at the moment of each parse, so a library edit reaches the next write.
 *
 * A scoped library wins over the installed one for the length of the call. With neither — a parse that reads the library run outside
 * `withSchemaLibrary` in an app, or before the server installed its own — the read THROWS "no schema library installed" (`Q-668`): an
 * empty default answered every `$ref` as missing, a wrong refusal with nothing to say the setup was wrong. Nothing here reads a file,
 * an environment variable or a logger.
 */
import { z } from 'zod';
import type { KnowledgeType, TypeSchema } from './vocabulary.js';
import { canonicalJson } from './canonical-json.js';
import { libraryEntryNameOf } from './library-ref-name.js';

/** What a parse needs of one schema-library entry: its name, the kind it is filed under, and its definition. */
export interface SchemaLibraryEntryLike {
  name: string;
  knowledgeType: KnowledgeType;
  schema: Omit<TypeSchema, '$ref'>;
}

/** The entries a parse reads, asked for at the moment of the parse. */
export type SchemaLibrarySource = () => readonly SchemaLibraryEntryLike[];

/** The library read when none is installed or scoped: a setup error, said as one, never an empty library that answers wrongly. */
const NONE_INSTALLED: SchemaLibrarySource = () => {
  throw new Error('no schema library installed: a parse that reads the schema library ran outside withSchemaLibrary(entries, read) '
    + 'and before any library was installed. An app scopes its entries with withSchemaLibrary (or passes them to validateSpaceMeta); '
    + 'the server installs its own at import (server/src/spaces/library-ref-expansion.ts).');
};

let installed: SchemaLibrarySource = NONE_INSTALLED;
const scoped: (readonly SchemaLibraryEntryLike[])[] = [];

/**
 * Install the library every parse reads when no call scopes its own. The server's, in `@ythril-network/schema/internal` only: an app scopes its
 * entries with {@link withSchemaLibrary} instead, so no app replaces a library another part of the process reads.
 */
export function useSchemaLibrary(source: SchemaLibrarySource): void {
  installed = source;
}

/**
 * Run `read` with `entries` as the library — for an app checking a meta against the entries it knows, and for a test.
 *
 * `read` must be synchronous: the scope ends when it returns, so the awaited half of an async `read` would run against the installed
 * library (or another call's scope). A `read` that returns a promise, or any thenable, throws.
 */
export function withSchemaLibrary<T>(entries: readonly SchemaLibraryEntryLike[], read: () => T): T {
  scoped.push(entries);
  let result: T;
  try { result = read(); } finally { scoped.pop(); }
  if (result !== null && (typeof result === 'object' || typeof result === 'function')
    && typeof (result as { then?: unknown }).then === 'function') {
    throw new Error('withSchemaLibrary: read returned a promise (a thenable): an async read is not supported, because the library is '
      + 'scoped only until read returns. Await what you need first, then parse synchronously inside withSchemaLibrary.');
  }
  return result;
}

/** The library a parse reads now: the innermost scoped one, else the installed one; throws when neither exists. */
export function currentSchemaLibrary(): readonly SchemaLibraryEntryLike[] {
  return scoped.length > 0 ? scoped[scoped.length - 1]! : installed();
}

/** The library entry's definition for a `library:<name>` reference, or undefined when there is none. */
export function libraryDefinitionOf(ref: string): Record<string, unknown> | undefined {
  const name = libraryEntryNameOf(ref);
  if (name === undefined) return undefined;
  return currentSchemaLibrary().find(e => e.name === name)?.schema as Record<string, unknown> | undefined;
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
  // A `$ref` naming no library entry is refused for its format, as a bare one is, not told its entry "does not exist".
  if (libraryEntryNameOf($ref) === undefined) {
    ctx.addIssue({ code: 'custom', input: value, message: '$ref must be in format "library:<name>"' });
    return z.NEVER;
  }

  const def = libraryDefinitionOf($ref);
  // Compared as canonical JSON (`canonical-json.ts`): two definitions that differ only in key order are equal.
  if (def && canonicalJson(rest) === canonicalJson(def)) return { $ref };

  const fields = def
    ? [...new Set([...Object.keys(rest), ...Object.keys(def)])].filter(k => canonicalJson(rest[k]) !== canonicalJson(def[k]))
    : Object.keys(rest);
  const entry = libraryEntryNameOf($ref) ?? $ref;
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
