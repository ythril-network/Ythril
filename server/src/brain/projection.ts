/**
 * One projection grammar, two places that apply it.
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
 * rule that is not negotiable — **the embedding vector can never be projected back IN**. `query.ts` keeps
 * building a Mongo projection and now derives it from here, so a change to the grammar cannot reach one door
 * and not the other.
 *
 * ## Inclusion and exclusion cannot mix, and that is Mongo's rule rather than ours
 *
 * MongoDB refuses a projection that both includes and excludes (except for `_id`), so `query` has always had
 * to pick a mode from what the caller sent. Recall has no such constraint technically — but a projection that
 * behaved differently on the two doors would be worse than one that is merely restricted, so the same rule
 * applies to both. The mode is decided by the non-`_id` fields, exactly as `mergeEmbeddingExclusion` decided
 * it before this module existed.
 */

import { WRITE_GUARD_FIELDS } from '../sync/local-only-fields.js';

/** Which way a projection reads, and the paths it names, pre-split on `.` so no applier re-parses. */
export interface NormalisedProjection {
  /** `true` when the caller listed fields to KEEP; `false` when they listed fields to DROP. */
  include: boolean;
  /** Each named field as its path segments — `properties.status` becomes `['properties','status']`. */
  paths: string[][];
  /** `_id` is kept in inclusion mode unless the caller explicitly said `_id: 0`, matching Mongo. */
  keepId: boolean;
  /**
   * The caller wrote `_id: 1` themselves.
   *
   * Behaviourally redundant — Mongo includes `_id` unless told otherwise — but the emitted Mongo projection
   * is pinned by a gate, and silently dropping a key the caller sent would change a documented artefact for
   * no gain. Echoing it back keeps `mergeEmbeddingExclusion` byte-identical to what it produced before this
   * module existed.
   */
  idExplicit: boolean;
}

/** A field the caller can never have, whatever they ask for. */
export const NEVER_PROJECTABLE = 'embedding';

const truthy = (v: unknown) => v === 1 || v === true || v === '1';

/**
 * Read a caller's projection into the one normalised form.
 *
 * `undefined` for an absent or empty projection, so a caller can tell "project nothing" from "project
 * everything" — the difference matters, because applying an empty inclusion projection would return records
 * holding only `_id`, and that is not what an omitted parameter means.
 */
export function normaliseProjection(
  projection?: Record<string, unknown> | null,
): NormalisedProjection | undefined {
  if (!projection || Object.keys(projection).length === 0) return undefined;

  const entries = Object.entries(projection);
  // The mode comes from the non-_id fields, because `_id: 0` is legal alongside an inclusion list.
  const include = entries.some(([k, v]) => k !== '_id' && truthy(v));

  const paths: string[][] = [];
  let keepId = true;
  let idExplicit = false;
  for (const [key, value] of entries) {
    if (key === '_id') {
      // `_id: 0` drops it in either mode. `_id: 1` is the default, so it needs no path of its own.
      if (!truthy(value)) keepId = false; else idExplicit = true;
      continue;
    }
    // In inclusion mode the vector is silently dropped rather than refused: a caller asking for it has made
    // a mistake we can correct without failing their read, and refusing would be a new 400 on a parameter
    // that has always accepted it.
    if (key === NEVER_PROJECTABLE) continue;
    if (include !== truthy(value)) continue; // a mixed projection: honour the mode, ignore the stragglers
    paths.push(key.split('.'));
  }
  return { include, paths, keepId, idExplicit };
}

/**
 * The Mongo projection for a normalised one — what `query` hands the driver.
 *
 * Kept here rather than in `query.ts` so the Mongo form and the in-memory form are derived from ONE reading
 * of the caller's intent. They were never going to disagree while there was only one of them; this is the
 * commit that creates the second.
 */
export function toMongoProjection(norm: NormalisedProjection | undefined): Record<string, 0 | 1> {
  if (!norm) return { [NEVER_PROJECTABLE]: 0 };
  const out: Record<string, 0 | 1> = {};
  for (const p of norm.paths) out[p.join('.')] = norm.include ? 1 : 0;
  if (norm.include) {
    if (!norm.keepId) out['_id'] = 0;
    else if (norm.idExplicit) out['_id'] = 1;
  } else {
    // An exclusion projection must still drop the vector, and `_id: 0` is the one inclusion Mongo allows here.
    out[NEVER_PROJECTABLE] = 0;
    if (!norm.keepId) out['_id'] = 0;
  }
  return out;
}

/**
 * A Mongo projection that also withholds this instance's write guard (`Q-439`) — what a read that hands a caller's
 * projection to the driver applies last, because an INCLUSION projection reaches any stored field it names.
 *
 * ## What it prevents
 *
 * `_functionalGuard` is withheld from every answer (`NEVER_RETURNED_FIELDS`), but a `filter` with
 * `projection: { _functionalGuard: 1 }` asks the store for the field by name and gets it. The vector has its own rule for
 * that (`NEVER_PROJECTABLE`); the guard is a second field with the same promise, and it is kept apart so the vector's
 * projection stays byte for byte what it was.
 *
 *  - an exclusion (or no projection) gains `field: 0`;
 *  - an inclusion loses the field. When that leaves nothing to include the answer is the id alone — `{}` would be a
 *    projection of NOTHING, which the store reads as "every field", the opposite of what was asked.
 */
export function withoutWriteGuard(projection: Record<string, 0 | 1>): Record<string, 0 | 1> {
  const out = { ...projection };
  const include = Object.entries(projection).some(([k, v]) => k !== '_id' && v === 1);
  for (const f of WRITE_GUARD_FIELDS) {
    if (include) delete out[f]; else out[f] = 0;
  }
  if (include && !Object.keys(out).some(k => k !== '_id')) out['_id'] = 1;
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
    delete out[NEVER_PROJECTABLE];
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
  // otherwise be shared with the caller's own record and mutated by the delete below.
  const out = structuredClone(src) as Record<string, unknown>;
  for (const p of norm.paths) deletePath(out, p);
  delete out[NEVER_PROJECTABLE];
  if (!norm.keepId) delete out['_id'];
  return out;
}
