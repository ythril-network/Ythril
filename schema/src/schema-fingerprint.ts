/**
 * The text a space's schema fingerprint is the hash of: the one canonical form of "the schema", whatever order its keys were written in and
 * whatever of a meta is not the schema (Q-734).
 *
 * ## What it prevents
 *
 * A fingerprint that depends on the instance (a key order, the purpose text, an empty kind written as `{}` on one member and left out on
 * another) makes two members that hold one schema stamp their records differently, and a record's stamp could then name no snapshot any
 * peer holds. So the text is taken of the SCHEMA alone: `canonicalJson({ format, typeSchemas, rules })`, with every kind that holds no type
 * left out and an absent rules map written as an empty one. Purpose, usage notes, the validation mode, linkage, suppression, history and
 * every server-owned field are outside it.
 *
 * ## What it takes, and what it does not do
 *
 * It takes RESOLVED input (ADR 19): the caller inlines the library `$ref`s it can resolve first (the server's `inlineResolvableRefs`), so a
 * `$ref` and the definition it names give one text. It never hashes (this package compares texts and keeps no hash of its own, see
 * `canonical-json.ts`): the fingerprint is the server's `sha256` of this text as UTF-8, and the text is also what a schema snapshot holds, so
 * a snapshot is verified by hashing it and by making its text again from what it parses to. `undefined` is the empty schema, whose text is
 * fixed for as long as stored stamps name it.
 */
import { canonicalJson } from './canonical-json.js';

/** The format the text names, so a later format is told from this one. Part of the text, so changing it changes every fingerprint. */
export const SCHEMA_FINGERPRINT_FORMAT = 1;

/** The field a record carries its stamp in (and the meta carries its own variation's fingerprint in): the one spelling of the name. */
export const SCHEMA_FINGERPRINT_FIELD = 'schemaFingerprint';

/** A schema fingerprint as it is stamped and sent: 64 lowercase hex. The one test of that shape; anything else is not a fingerprint. */
export const isSchemaFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** The parts of a meta the text is made of. */
export interface FingerprintedMeta {
  typeSchemas?: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>;
  rules?: Readonly<Record<string, unknown>>;
}

/** The kinds that hold at least one type: `{}` for a kind and no key for it are one schema. */
function heldKinds(typeSchemas: FingerprintedMeta['typeSchemas']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [kind, types] of Object.entries(typeSchemas ?? {})) {
    if (types && typeof types === 'object' && Object.values(types).some(t => t !== undefined)) out[kind] = types;
  }
  return out;
}

/** The canonical text of the schema `meta` holds (resolved input); the empty schema's text for `undefined`. */
export function schemaFingerprintTextOf(meta: FingerprintedMeta | undefined): string {
  return canonicalJson({ format: SCHEMA_FINGERPRINT_FORMAT, typeSchemas: heldKinds(meta?.typeSchemas), rules: meta?.rules ?? {} }) as string;
}
