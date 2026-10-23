/**
 * One projection grammar, every place that applies it, and the one rule none of them may break.
 *
 * ## Why this is a leaf module
 *
 * `query` has had a `projection` since it shipped, and it is a MONGO projection — handed to the driver,
 * applied in the database. `recall` had none, and the canary operator measured what that costs
 * (2026-08-16T1358Z): a board sweep asking for fifteen names, a `from`, a `kind` and a `status` returned
 * **100,547 characters** where the data they wanted was about 1.5 KB. Their client refused the response and
 * spilled it to disk.
 *
 * Recall cannot push a projection into the database. Its results come out of a vector search, are fused with
 * a lexical ranking, may be reranked, and on the MCP door are rebuilt through `toRecallRecord`'s allowlist.
 * By the time there is something to project, it is an object in memory. So the projection has to be applied
 * in memory — and the moment there are two appliers, the interesting question is whether they agree about
 * what a projection MEANS.
 *
 * This module is that agreement: inclusion-versus-exclusion, `_id`'s special case, dotted paths, and the one
 * rule that is not negotiable — **a withheld field can never be projected back IN**.
 *
 * ## The withheld step (`Q-446`, `Q-357`)
 *
 * `NEVER_RETURNED_FIELDS` names what no read returns: the vector, `deliveredBy` and the write guard. A
 * projection is the one parameter a caller can use to ask for a field by name, so it is where that promise
 * is kept, once, for every door:
 *
 *  - a key whose FIRST path segment is a withheld field is dropped (never refused), in either mode;
 *  - an exclusion — and no projection at all — excludes every withheld field;
 *  - an inclusion left with no paths after the drop answers `_id` alone, so `{embedding: 1}`,
 *    `{_id: 0, embedding: 1}` and `{_id: 1}` all answer `{_id}` on every applier.
 *
 * What it prevents: the vector rule used to be the only one here, and the write guard had a hand-written copy
 * for one more field (`withoutWriteGuard`) while `deliveredBy` had none — so every `filter` answered the peer
 * that delivered each record, and `{embedding: 1}` became `{}`, the store's "every field". One list, read from
 * `recall-shape.ts`, means a fourth withheld field is covered by being named there.
 *
 * ## The mode is decided once
 *
 * MongoDB refuses a projection that both includes and excludes (except for `_id`), so the mode comes from the
 * non-`_id` keys when there are any; a sole `_id` decides it by its own value (`{_id: 1}` is an inclusion of
 * `_id`, `{_id: 0}` an exclusion of it). `{_id: 1, description: 0}` is an exclusion. Every applier below reads
 * the mode from `normaliseProjection`, so none can read it differently.
 */

import { NEVER_RETURNED_FIELDS } from './recall-shape.js';

/** Which way a projection reads, and the paths it names, pre-split on `.` so no applier re-parses. */
export interface NormalisedProjection {
  /** `true` when the caller listed fields to KEEP; `false` when they listed fields to DROP. */
  include: boolean;
  /** Each named field as its path segments — `properties.status` becomes `['properties','status']`. */
  paths: string[][];
  /** `_id` is kept in inclusion mode unless the caller explicitly said `_id: 0`, matching Mongo. */
  keepId: boolean;
  /**
   * `_id: 1` belongs in the Mongo form: the caller wrote it, or an inclusion has nothing else to include.
   *
   * Behaviourally redundant beside other included paths — Mongo includes `_id` unless told otherwise — and
   * load-bearing when there are none, because an empty Mongo projection reads as "every field".
   */
  idExplicit: boolean;
}

/**
 * The fields a caller can never have, whatever they ask for — `NEVER_RETURNED_FIELDS`, not a second list.
 * Kept under its old name because it is the name this module's rule has always been read by.
 */
export const NEVER_PROJECTABLE: readonly string[] = NEVER_RETURNED_FIELDS;

const WITHHELD: ReadonlySet<string> = new Set(NEVER_PROJECTABLE);

/** Is this projection key (or predicate path) a withheld field or a path into one? Whole first segment only. */
export function isWithheldPath(key: string): boolean {
  return WITHHELD.has(key.split('.')[0]!);
}

const truthy = (v: unknown) => v === 1 || v === true || v === '1';

/**
 * Read a caller's projection into the one normalised form.
 *
 * `undefined` for an absent or empty projection, so a caller can tell "project nothing" from "project
 * everything" — the difference matters, because applying an empty inclusion projection would return records
 * holding only `_id`, and that is not what an omitted parameter means. Every applier withholds on that branch
 * too.
 */
export function normaliseProjection(
  projection?: Record<string, unknown> | null,
): NormalisedProjection | undefined {
  if (!projection || Object.keys(projection).length === 0) return undefined;

  const entries = Object.entries(projection);
  const nonId = entries.filter(([k]) => k !== '_id');
  // The mode comes from the non-_id keys (a withheld one included: `{embedding: 1}` is an inclusion that ends
  // up naming nothing), and from `_id` itself only when it is the sole key.
  const include = nonId.length > 0 ? nonId.some(([, v]) => truthy(v)) : truthy(projection['_id']);

  const paths: string[][] = [];
  for (const [key, value] of nonId) {
    // A withheld field is dropped rather than refused: a caller asking for it has made a mistake we can correct
    // without failing their read, and refusing would be a new 400 on a parameter that has always accepted it.
    if (isWithheldPath(key)) continue;
    if (include !== truthy(value)) continue; // a mixed projection: honour the mode, ignore the stragglers
    paths.push(key.split('.'));
  }

  const idSent = '_id' in projection;
  let keepId = !idSent || truthy(projection['_id']);
  let idExplicit = idSent && truthy(projection['_id']);
  // An inclusion with nothing left to include answers the id, whatever `_id` said — never "every field".
  if (include && paths.length === 0) { keepId = true; idExplicit = true; }
  return { include, paths, keepId, idExplicit };
}

/**
 * The Mongo projection for a normalised one — what a store read hands the driver.
 *
 * Kept here rather than in `query.ts` so the Mongo form and the in-memory form are derived from ONE reading
 * of the caller's intent.
 */
export function toMongoProjection(norm: NormalisedProjection | undefined): Record<string, 0 | 1> {
  const out: Record<string, 0 | 1> = {};
  if (!norm) {
    for (const f of NEVER_PROJECTABLE) out[f] = 0;
    return out;
  }
  for (const p of norm.paths) out[p.join('.')] = norm.include ? 1 : 0;
  if (norm.include) {
    // An inclusion already omits every withheld field: none of them can be among its paths.
    if (!norm.keepId) out['_id'] = 0;
    else if (norm.idExplicit) out['_id'] = 1;
  } else {
    // An exclusion must still drop every withheld field, and `_id: 0` is the one inclusion Mongo allows here.
    for (const f of NEVER_PROJECTABLE) out[f] = 0;
    if (!norm.keepId) out['_id'] = 0;
  }
  return out;
}

/** Read a dotted path out of a record, or `undefined` when any segment is missing. */
function readPath(src: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = src;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Write a dotted path into a target, creating the intermediate objects. */
function writePath(dst: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = dst;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    if (typeof cur[seg] !== 'object' || cur[seg] === null) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

/** Delete a dotted path from a target, leaving its parents in place. */
function deletePath(dst: Record<string, unknown>, path: string[]): void {
  let cur: Record<string, unknown> = dst;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]!];
    if (typeof next !== 'object' || next === null) return;
    cur = next as Record<string, unknown>;
  }
  delete cur[path[path.length - 1]!];
}

/**
 * One record, projected — a new object, never a mutation of the input.
 *
 * Copying is not caution: a recall result is handed to the traverse builder, to the spill writer and to the
 * audit outcome, and `stripContentIfAsked` already carries the same note for the same reason. Projecting in
 * place would change what those saw.
 *
 * Every withheld field is removed on every branch, the no-projection one included, so a caller of this function
 * does not also have to remember to strip them.
 *
 * An absent path is simply absent from the output, matching Mongo: asking for a field a record does not have
 * is not an error and does not produce a null.
 */
export function applyProjection<T extends object>(
  record: T,
  norm: NormalisedProjection | undefined,
): Record<string, unknown> {
  const src = record as unknown as Record<string, unknown>;
  if (!norm) {
    const out = { ...src };
    for (const f of NEVER_PROJECTABLE) delete out[f];
    return out;
  }

  if (norm.include) {
    const out: Record<string, unknown> = {};
    if (norm.keepId && '_id' in src) out['_id'] = src['_id'];
    for (const p of norm.paths) {
      const v = readPath(src, p);
      if (v !== undefined) writePath(out, p, v);
    }
    return out;
  }

  // Exclusion: a shallow copy is not enough, because a dotted path reaches into a nested object that would
  // otherwise be shared with the caller's own record and mutated by the delete below. The withheld fields go
  // first, so a vector is never cloned only to be dropped.
  const visible = { ...src };
  for (const f of NEVER_PROJECTABLE) delete visible[f];
  const out = structuredClone(visible) as Record<string, unknown>;
  for (const p of norm.paths) deletePath(out, p);
  if (!norm.keepId) delete out['_id'];
  return out;
}

/**
 * The store projection a MERGE across members reads with, and the keys to take off the merged rows again (`Q-446` R8).
 *
 * ## What it prevents
 *
 * A personal view with more than one member is read a window per member and merged by the requested order over the
 * rows as the store returned them. A row missing an order key sorts last, so a projection that left an order key out
 * (`{fact: 1}`, `{seq: 0}`, `{_id: 0}`) merged the members by whatever keys were left, and answered a page in an order
 * nobody asked for, with a 200. So, for the merge only:
 *
 *  - in inclusion mode every order key and `_id` is added to the read;
 *  - in exclusion mode a caller's exclusion of an order key or of `_id` is lifted;
 *  - a key whose first segment a caller path SHARES (`type.x` under `sort: type`) is left alone, and the merge orders
 *    by the caller's value of that segment — widening the caller's path would answer more than was asked.
 *
 * `strip` names what was added, and the caller deletes those keys from every merged row BEFORE anything else reads
 * the page (decorations, the byte budget), so the answer is exactly what the projection asked for.
 */
export function projectionForOrderedMerge(
  projection: Record<string, unknown> | undefined,
  orderKeys: readonly string[],
): { read: Record<string, 0 | 1> | undefined; strip: string[] } {
  const norm = normaliseProjection(projection);
  if (!norm) return { read: undefined, strip: [] };
  const keys = [...new Set([...orderKeys, '_id'])];
  const shared = (k: string) => norm.paths.some(p => p[0] === k && p.length > 1);
  const strip: string[] = [];
  let paths = norm.paths;
  let keepId = norm.keepId;
  for (const k of keys) {
    if (shared(k)) continue;
    if (k === '_id') {
      if (!keepId) { keepId = true; strip.push(k); }
      continue;
    }
    const named = paths.some(p => p.length === 1 && p[0] === k);
    if (norm.include && !named) { paths = [...paths, [k]]; strip.push(k); }
    if (!norm.include && named) { paths = paths.filter(p => !(p.length === 1 && p[0] === k)); strip.push(k); }
  }
  return { read: toMongoProjection({ ...norm, paths, keepId, idExplicit: norm.idExplicit && keepId }), strip };
}
