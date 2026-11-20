/**
 * The schema library as every space reads it: each entry with the RDF addresses its group's namespace gives it (Q-748, design r4 §4.2).
 *
 * ## What it prevents
 *
 * A group namespace (`config.json` `schemaLibraryNamespaces`) names an entry's type `<ns><seg(type)>` and its properties as fragments of it.
 * If that address were computed where a term is NAMED (the export, slices B to D), the resolved meta a space validates against, the
 * definition a `$ref` round trip shows, what a peer is sent and the schema fingerprint would all lack it, and two readers of one space would
 * disagree on a term's address. So the address is put INTO the entry here, once, and the library is installed through this module
 * (`library-ref-expansion.ts`, `schema-validation.ts`): every reader sees the same effective entry, and a namespace change changes the
 * fingerprint of every space with RDF ON linking the group, as a library edit does. A space with RDF off names nothing: what it sends its
 * peers and fingerprints is resolved from the entries as stored (`inlineResolvableRefs`, review finding 5), so RDF stays inert when off.
 *
 * ## The rules, inside
 *
 * - An entry's own `iri` (on the type or on a property) wins; the namespace fills only what the entry leaves unset.
 * - A namespace the file holds that no door would accept (a hand edit: a reserved or malformed prefix, a non-namespace IRI) names nothing
 *   and is said once ({@link unusableNamespaces}); it is never turned into an address.
 * - The library as STORED is untouched: the library's own doors read and write the entries as they are held.
 *
 * Cost: the effective list is rebuilt only when the stored library or the namespaces change (one memo), because a validation reads it on
 * every write.
 */
import { NamespaceIriZ, PrefixZ, libraryEntryNameOf, type KnowledgeType } from '@ythril-network/schema';
import { getConfig, getSchemaLibrary } from '../config/loader.js';
import type { SpaceConfig, SpaceMeta, TypeSchema } from '../config/types.js';
import type { ParsedLibraryEntry } from './body-schemas.js';
import { libraryTermIri, resolveTermIri, termClashes, termOwnerName } from '../rdf/term-iri.js';
import { RDF_BASE_STANDS_STATUS } from './rdf-settle.js';
import { log, peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';

/** A group's namespace as `config.json` holds it. */
export interface LibraryNamespace { prefix: string; iri: string }

const saidOnce = warnOnce<string>();

/** The namespaces `config.json` holds, by group, as stored (unchecked); `{}` before the config is loaded. */
function storedNamespaces(): Record<string, LibraryNamespace> {
  try { return getConfig().schemaLibraryNamespaces ?? {}; } catch { return {}; }
}

/** Why a stored namespace names nothing, or `undefined` when a door would accept it. */
function unusableReason(ns: unknown): string | undefined {
  const n = ns as Partial<LibraryNamespace> | null;
  if (!n || typeof n !== 'object') return 'not an object';
  if (!PrefixZ.safeParse(n.prefix).success) return `the prefix ${peerText(String(n.prefix))} is not one a namespace may take`;
  if (!NamespaceIriZ.safeParse(n.iri).success) return `${peerText(String(n.iri))} is not a namespace IRI (absolute, ending in "/", holding no "#")`;
  return undefined;
}

/** The namespaces that name something, by group: every stored one a door would accept. */
export function libraryNamespaces(): Record<string, LibraryNamespace> {
  // fromEntries defines each key as an own property: `out[group] = ...` for a group called `__proto__` set the map's prototype instead.
  return Object.fromEntries(Object.entries(storedNamespaces()).filter(([, ns]) => unusableReason(ns) === undefined).map(([group, ns]) => [group, { prefix: ns.prefix, iri: ns.iri }]));
}

/**
 * The namespace `group` holds in `namespaces`, or `undefined`. THE one lookup by group name: a group is any name the library accepts, and a
 * plain object answers `constructor`, `toString` and `__proto__` with what every object inherits (lens finding 6), so only an own key counts.
 */
export function namespaceOfGroup<T>(byGroup: Readonly<Record<string, T>>, group: string): T | undefined {
  return Object.hasOwn(byGroup, group) ? byGroup[group] : undefined;
}

/** The stored namespaces that name nothing, each with why; each is said once in the log when found. */
export function unusableNamespaces(): { group: string; reason: string }[] {
  const out: { group: string; reason: string }[] = [];
  for (const [group, ns] of Object.entries(storedNamespaces())) {
    const reason = unusableReason(ns);
    if (reason === undefined) continue;
    out.push({ group, reason });
    saidOnce(group, () => log.warn(`schema library group ${peerText(group)}: its namespace in config.json names nothing: ${peerText(reason)}`));
  }
  return out;
}

/** `entry` with the addresses `namespace` gives it, where the entry sets none. A new object; the stored entry is untouched. */
export function entryWithNamespace(entry: ParsedLibraryEntry, namespace: string): ParsedLibraryEntry {
  const schema = entry.schema as ParsedLibraryEntry['schema'] & { iri?: string; propertySchemas?: Record<string, { iri?: string }> };
  const props = schema.propertySchemas
    ? Object.fromEntries(Object.entries(schema.propertySchemas).map(([p, ps]) => [p, { ...ps, iri: ps.iri ?? libraryTermIri(namespace, entry.typeName, p) }]))
    : undefined;
  return {
    ...entry,
    schema: { ...schema, iri: schema.iri ?? libraryTermIri(namespace, entry.typeName), ...(props ? { propertySchemas: props } : {}) } as ParsedLibraryEntry['schema'],
  };
}

/** One state of the library a write could leave: its entries as held and the group namespaces that name something. */
export interface LibraryState { library: readonly ParsedLibraryEntry[]; namespaces: Record<string, LibraryNamespace> }

/** A refusal of a library write that would rename or clash an RDF-enabled space's terms (design r4 §4.2). */
export interface LibraryRdfRefusal {
  status: typeof RDF_BASE_STANDS_STATUS;
  body: { error: string; code: 'rdf_term_rename' | 'rdf_term_clash'; spaces?: string[]; space?: string; terms?: string[]; iri?: string };
}

/** `meta` with each `$ref` type replaced by its entry in `state`, namespaces applied: the meta the resolver names the space by in that state. */
function resolvedUnder(meta: SpaceMeta, state: LibraryState): SpaceMeta {
  const types = (meta.typeSchemas ?? {}) as Record<string, Record<string, TypeSchema> | undefined>;
  const out: Record<string, Record<string, TypeSchema>> = {};
  for (const [kind, map] of Object.entries(types)) {
    out[kind] = {};
    for (const [name, def] of Object.entries(map ?? {})) {
      const ref = def?.$ref ? libraryEntryNameOf(def.$ref) : undefined;
      const entry = ref === undefined ? undefined : state.library.find(e => e.name === ref);
      const ns = entry?.schemaGroup ? namespaceOfGroup(state.namespaces, entry.schemaGroup) : undefined;
      out[kind]![name] = entry ? (ns ? entryWithNamespace(entry, ns.iri) : entry).schema : def;
    }
  }
  return { ...meta, typeSchemas: out as SpaceMeta['typeSchemas'] };
}

/** Every term address of `meta` (resolved), by `kind:type[:prop]`. */
function termAddresses(meta: SpaceMeta): Map<string, string> {
  const out = new Map<string, string>();
  for (const [kind, map] of Object.entries((meta.typeSchemas ?? {}) as Record<string, Record<string, TypeSchema> | undefined>)) {
    for (const [type, def] of Object.entries(map ?? {})) {
      out.set(`${kind}:${type}`, resolveTermIri(meta, kind as KnowledgeType, type));
      for (const prop of Object.keys(def?.propertySchemas ?? {})) out.set(`${kind}:${type}:${prop}`, resolveTermIri(meta, kind as KnowledgeType, type, prop));
    }
  }
  return out;
}

/**
 * What a library write that moves the library from `before` to `after` does to the RDF-enabled spaces of `spaces` that link one of its
 * entries: `null` when nothing of theirs is renamed or clashes; 409 `rdf_term_rename` naming the spaces whose term addresses would change,
 * unless `rebase`; 409 `rdf_term_clash` naming both terms when the write would give two terms of one such space one address. Pure.
 */
export function libraryRdfGuard(spaces: readonly SpaceConfig[], before: LibraryState, after: LibraryState, rebase: boolean): LibraryRdfRefusal | null {
  const renamed: string[] = [];
  for (const space of spaces) {
    const meta = space.meta;
    if (meta?.rdf?.enabled !== true || !meta.rdf.base || !linksAnEntry(meta, [...before.library, ...after.library])) continue;
    const change = termChange(space.id, meta, before, meta, after);
    if (change === 'renamed') renamed.push(space.id); else if (change) return change;
  }
  return renameRefusal(renamed, rebase, 'library change');
}

/**
 * What a write of ONE space's schema from `before` to `after` does to its RDF terms under the library as it stands (review finding 9: a
 * group apply replaces a type by a namespaced entry): `null` when nothing is renamed or clashes, or the space has RDF off afterwards; 409
 * `rdf_term_rename` unless `rebase`; 409 `rdf_term_clash` naming both terms. The guard the library's entry writes run, for a write of the
 * space's own definitions through a library door.
 */
export function spaceEditRdfGuard(spaceId: string, before: SpaceMeta, after: SpaceMeta, rebase: boolean): LibraryRdfRefusal | null {
  if (after.rdf?.enabled !== true || !after.rdf.base) return null;
  const state = currentLibraryState();
  const change = termChange(spaceId, before.rdf?.enabled === true && before.rdf.base ? before : after, state, after, state);
  return change === 'renamed' ? renameRefusal([spaceId], rebase, 'change') : change;
}

/** One space's terms from `metaBefore` under `stateBefore` to `metaAfter` under `stateAfter`: a clash refusal, `'renamed'`, or `null`. */
function termChange(spaceId: string, metaBefore: SpaceMeta, stateBefore: LibraryState, metaAfter: SpaceMeta, stateAfter: LibraryState): LibraryRdfRefusal | 'renamed' | null {
  const next = resolvedUnder(metaAfter, stateAfter);
  const clashes = termClashes(next, Object.values(libraryNamespaces()));
  if (clashes.length > 0) {
    return { status: RDF_BASE_STANDS_STATUS, body: {
      code: 'rdf_term_clash', error: `in space ${peerText(spaceId)}, this change would give two terms one RDF address: ${clashes.map(c => c.message).join('; ')}`,
      // Structured for a client that words the refusal in its own language: the space, the first clash's terms and the address.
      space: spaceId, terms: clashes[0]!.owners.map(termOwnerName), iri: clashes[0]!.iri,
    } };
  }
  const was = termAddresses(resolvedUnder(metaBefore, stateBefore));
  const now = termAddresses(next);
  return [...now].some(([k, iri]) => was.has(k) && was.get(k) !== iri) ? 'renamed' : null;
}

/** The 409 `rdf_term_rename` naming `renamed`, or `null` when nothing is renamed or the caller sent `rebase`. */
function renameRefusal(renamed: readonly string[], rebase: boolean, what: string): LibraryRdfRefusal | null {
  if (renamed.length === 0 || rebase) return null;
  return { status: RDF_BASE_STANDS_STATUS, body: { code: 'rdf_term_rename', spaces: [...renamed], error: `this ${what} renames RDF terms of ${renamed.map(id => `space ${peerText(id)}`).join(', ')}, whose records' exports would name them differently from then on: send rebase: true to make the change on purpose` } };
}

/** Does `meta` reference one of `library`'s entries by `$ref`? */
function linksAnEntry(meta: SpaceMeta, library: readonly ParsedLibraryEntry[]): boolean {
  const names = new Set(library.map(e => e.name));
  for (const map of Object.values((meta.typeSchemas ?? {}) as Record<string, Record<string, TypeSchema> | undefined>)) {
    for (const def of Object.values(map ?? {})) {
      const ref = def?.$ref ? libraryEntryNameOf(def.$ref) : undefined;
      if (ref !== undefined && names.has(ref)) return true;
    }
  }
  return false;
}

/** The library as it stands now: the stored entries and the usable namespaces. */
export function currentLibraryState(): LibraryState {
  return { library: getSchemaLibrary(), namespaces: libraryNamespaces() };
}

let memo: { library: readonly ParsedLibraryEntry[]; key: string; out: ParsedLibraryEntry[] } | undefined;

/** The library every space reads: each entry of a group with a usable namespace carries its addresses. */
export function effectiveLibraryEntries(): ParsedLibraryEntry[] {
  const library = getSchemaLibrary();
  const namespaces = libraryNamespaces();
  // The entries' names and stamps are in the key as well as the array: one library door edits the held array in place before it saves.
  const key = `${JSON.stringify(namespaces)}|${library.map(e => `${e.name}@${String(e.updatedAt ?? '')}`).join('|')}`;
  if (memo && memo.library === library && memo.key === key) return memo.out;
  unusableNamespaces();
  const out = library.map((e) => {
    const ns = e.schemaGroup ? namespaceOfGroup(namespaces, e.schemaGroup) : undefined;
    return ns ? entryWithNamespace(e, ns.iri) : e;
  });
  memo = { library, key, out };
  return out;
}
