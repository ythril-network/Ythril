import { tagContains, textContains, propertiesValueContains } from './tag-filter.js';
import { textSearchOr, SEARCHABLE_FIELDS } from './text-search.js';

/**
 * What predicate do a list's CONVENIENCE filters mean for this collection?
 *
 * ## What this answers, and what it deliberately does not
 *
 * Five names that narrow a list without the caller writing a Mongo predicate: `tag`, `type`,
 * `description`, `properties` and `search`. They are the controls the Brain page's column headers send,
 * and until this module they were assembled by hand in five places — `buildFactFilter`, the entities
 * route, `listEdges`, `buildChronoQuery` and the file-meta route — each reading the same names, in the
 * same order, into the same three primitives. `filter` would have been the sixth, which is how the
 * browser and an agent come to disagree about what `tag` means.
 *
 * It does NOT answer the per-collection questions that only make sense somewhere: a fact's `entityName`
 * and an edge's `fromName`/`toName` are JOINS resolved per member space, chrono's `after`/`before` is a
 * date range, and an entity's `name` is an exact match. Herding those in would be a module with a flag
 * per caller, which is the failure mode of the rule that produced this one.
 *
 * ## THE TWO GUARDS THAT LIVE IN HERE, which is the point of it being a module
 *
 * **It merges under `$and`, never by assignment.** `textSearchOr` returns `{$or: [...]}`, and the old
 * assemblies `Object.assign` it straight onto the predicate they are building. That is correct only
 * while nothing else in the predicate is an `$or` — true of all four, because none of them has a
 * CALLER-SUPPLIED filter. `filter` does. A caller passing `{$or: [{type: 'note'}, {type: 'decision'}]}`
 * alongside `search` would have had their disjunction replaced by ours: no error, no log, and a
 * plausible answer over the wrong set. An assembly written by hand is exactly what would drop this — it
 * looks like the same four lines with one extra word.
 *
 * **It REFUSES rather than ignoring a convenience the collection cannot honour.** `links` reaches the
 * `filter` enum and carries none of these fields: a link is a pair of ids, with no tags, no type, no
 * description and no text to search. Silently dropping `search` there returns every link in the space,
 * and a filter that matched everything is indistinguishable from a filter that was ignored. Same shape
 * as `B-12`, where a collection reaching the enum without a sortable-field set crashed instead of
 * refusing — so the refusal lives in the function that RECEIVES the collection, not at a call site.
 *
 * A call with no conveniences returns the caller's predicate unchanged, byte for byte. Today's behaviour
 * has to survive this untouched, and an empty `$and` is not neutral to whoever debugs the query next.
 */

/** The collections whose text fields `search` knows how to span. */
export type ConvenienceCollection = keyof typeof SEARCHABLE_FIELDS;

/**
 * The convenience names, exported so both doors and the gate read ONE list.
 *
 * A sixth name added here and nowhere else fails the gate rather than quietly existing on one door —
 * which is how `tag` and `search` came to be REST-only in the first place.
 */
export const CONVENIENCE_KEYS = ['tag', 'type', 'description', 'properties', 'search'] as const;

export type ConvenienceKey = typeof CONVENIENCE_KEYS[number];

export type ListConveniences = Partial<Record<ConvenienceKey, string>>;

/**
 * Whether this collection carries authored metadata at all.
 *
 * Read off `SEARCHABLE_FIELDS` rather than declared a second time. The five collections with text to
 * search are exactly the five that carry `tags`, `type`, `description` and `properties`; `links` is the
 * one that carries none of them, because it IS the relationship rather than a record describing one.
 * Deriving it means there is no second list to fall out of step — and a future collection that breaks
 * the coincidence gets a loud refusal rather than a silent miss, which is the right way round.
 */
export function convenienceFieldsFor(collection: string): readonly string[] | undefined {
  return (SEARCHABLE_FIELDS as Record<string, readonly string[]>)[collection];
}

/** Read the conveniences out of an arbitrary argument bag, ignoring anything that is not a string. */
export function conveniencesFrom(args: Record<string, unknown>): ListConveniences {
  const out: ListConveniences = {};
  for (const k of CONVENIENCE_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/** Which conveniences were actually asked for, in declaration order. */
export function conveniencesAsked(c: ListConveniences): ConvenienceKey[] {
  return CONVENIENCE_KEYS.filter(k => c[k] !== undefined);
}

/**
 * Merge the conveniences into `base`. `base` is never mutated.
 *
 * Returns `{ error }` when the collection cannot honour them, so a caller cannot receive the refusal
 * quietly — the one thing a hand-written copy always drops. `collection` decides only what `search`
 * spans; every other convenience means the same thing wherever it is honoured.
 */
export function conveniencePredicate(
  collection: string,
  conveniences: ListConveniences,
  base: Record<string, unknown> = {},
): { predicate: Record<string, unknown> } | { error: string } {
  const asked = conveniencesAsked(conveniences);
  if (asked.length === 0) return { predicate: base };

  const fields = convenienceFieldsFor(collection);
  if (!fields) {
    return {
      error: `\`${collection}\` cannot be narrowed by ${asked.map(k => `\`${k}\``).join(', ')} — it holds `
        + 'no tags, type, description or text of its own. Use `filter` with a predicate on its own fields '
        + 'instead.',
    };
  }

  /*
   * Each convenience becomes its own clause rather than a key on one object. Two of the five can produce
   * `$or` or `$expr`, and so can the caller's `base` — so there is no key here that is safe to assign.
   */
  const clauses: Record<string, unknown>[] = [];

  if (conveniences.tag) clauses.push({ tags: tagContains(conveniences.tag) });
  if (conveniences.type) clauses.push({ type: conveniences.type });
  // Per-COLUMN, distinct from `search`: a column control that also matched the name would lie about
  // what it does. Both exist on purpose and the difference is the whole reason there are two.
  if (conveniences.description) clauses.push({ description: textContains(conveniences.description) });
  // Scans every property VALUE (owner's call). `propertiesValueContains` returns `$expr`.
  if (conveniences.properties) clauses.push(propertiesValueContains(conveniences.properties));

  const search = textSearchOr(conveniences.search, fields);
  if (search) clauses.push(search);

  if (clauses.length === 0) return { predicate: base };

  /*
   * `$and` even for a single clause, and even when `base` is empty. Flattening the one-clause case would
   * be a second code path that only the single-convenience call exercises, and it is the path a reader
   * would then copy.
   */
  const baseClauses = Array.isArray(base['$and']) ? (base['$and'] as Record<string, unknown>[]) : [];
  const rest = { ...base };
  delete rest['$and'];
  const keptBase = Object.keys(rest).length > 0 ? [rest] : [];
  return { predicate: { $and: [...keptBase, ...baseClauses, ...clauses] } };
}

/**
 * The five conveniences as JSON-Schema properties, spread into the `filter` tool's `inputSchema`.
 *
 * DECLARED HERE rather than in the tool, so the names, what each one means and how each is assembled
 * live in one file. A tool spelling its own descriptions is a second account of this module's
 * behaviour, and the description is what a caller reads while constructing arguments — `help()` says so
 * — which makes it the copy that rots without anybody reporting it.
 */
export const CONVENIENCE_SCHEMA: Readonly<Record<ConvenienceKey, { type: 'string'; description: string }>> = {
  tag: {
    type: 'string',
    description: 'Only records carrying a tag that CONTAINS this, case-insensitively. A '
      + 'substring over the tag array, not an exact tag — `rel` finds `release`. For an exact '
      + 'tag use `filter: { tags: "release" }`.',
  },
  type: {
    type: 'string',
    description: 'Only records of this knowledge type, exactly. The same thing as '
      + '`filter: { type: ... }` and offered because the list routes offer it; either works.',
  },
  description: {
    type: 'string',
    description: 'Only records whose DESCRIPTION contains this, case-insensitively. Narrows '
      + 'that one field — `search` below also spans the record\'s name or title, which is the '
      + 'whole reason both exist.',
  },
  properties: {
    type: 'string',
    description: 'Only records where some property VALUE contains this, case-insensitively. '
      + 'Keys are not matched. It scans, so it is the slowest of these — reach for a predicate '
      + 'on the property you mean when you know its name.',
  },
  search: {
    type: 'string',
    description: 'Freetext substring over the collection\'s own text fields — `name`/'
      + '`description` for entities, `fact`/`description` for facts, `label`/`description` for '
      + 'edges, `title`/`description` for chrono, `path`/`description` for files. Case-'
      + 'insensitive, and the value is escaped, so it is a substring and never a regex. '
      + 'REFUSED on `links`, which has no text of its own — a link is a pair of ids.',
  },
};
