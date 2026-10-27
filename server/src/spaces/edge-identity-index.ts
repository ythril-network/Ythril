/**
 * The edge identity index, its swap from the full unique index to the partial one, and the one question "may this space store a fork edge yet"
 * (Q-624, design rev 4 sections M2 and 5).
 *
 * ## What it prevents
 *
 * An edge's identity is `(from, to, label, fromKind, toKind)`, and one UNIQUE index holds it. A fork of an edge is the other peer's version of the SAME
 * relationship, so it carries the same five fields as its subject; a unique index that counts it refuses it as a duplicate (an E11000 nobody can explain).
 * The identity index is therefore PARTIAL, over rows whose `forkOf` is null or absent: a fork row (a string `forkOf`) is outside it, and the subject stays
 * the one holder of the identity. A query uses a partial index only when it names the predicate, so every identity reader names `forkOf: null`
 * (`brain/chosen-versions.ts`).
 *
 * A space built before this change holds the FULL index. Swapping one for the other must never leave a moment with no unique identity, so it is three steps,
 * each exported and each idempotent, and {@link ensurePartialEdgeIdentity} runs them in order:
 *
 *  1. {@link buildPartialEdgeIdentity}: build `edge_identity` BESIDE the full index (the store allows two under different names). It cannot fail on data: the
 *     partial index covers a subset of rows the full one already holds unique.
 *  2. {@link confirmPartialEdgeIdentity}: look. Only a `listIndexes` that shows it counts; a build that returned is not evidence.
 *  3. {@link dropFullEdgeIdentity}: drop the full index, matched by KEY SHAPE and the absence of `partialFilterExpression`, never by name. It refuses
 *     while `{ from: 1 }` is not in the list: the full index served every `from`-prefixed read through its prefix, and the partial one serves only a read
 *     that names `forkOf: null`, so dropping before `{ from: 1 }` stands would leave the entity delete guard, the relink and the Brain lists scanning.
 *
 * ## Readiness is read, never remembered
 *
 * {@link edgeIdentityAdmitsForks} is true only when `listIndexes` shows the partial index and no full unique one, and false on anything else, an error from
 * `listIndexes` included (it fails CLOSED). It is never kept in process memory: a restore recreates indexes, so a remembered "ready" is wrong after one.
 *
 * ## Who builds it
 *
 * A collection that is new or holds no edge is built here by `initSpace` through the declaration (`spaces/space-indexes.ts`, `buildEdgeIdentityIndex`),
 * under the declaration's `throw` policy: the swap is free on an empty collection, and a failure is a space with no unique edge identity, which does not
 * initialise. An existing collection with edges is the OWED JOB's (`spaces/edge-identity-owed.ts`), retried every tick, never a boot step and never the
 * background pass: its failure policy is "report, and the full index stands" - the space is never without a unique identity.
 */
import type { Document } from 'mongodb';
import { col } from '../db/mongo.js';
import { isNamespaceNotFound } from '../db/namespace-answers.js';
import { spaceCollection } from '../db/space-collection.js';

/** The five fields an edge's identity is made of, in the order the index and `edgeIdFor` read them. */
export const EDGE_IDENTITY_KEYS = Object.freeze({ from: 1, to: 1, label: 1, fromKind: 1, toKind: 1 } as const);

/** The partial identity index: unique over the five fields, over the rows whose `forkOf` is null or absent. */
export const EDGE_IDENTITY_INDEX = Object.freeze({
  keys: EDGE_IDENTITY_KEYS,
  options: Object.freeze({ name: 'edge_identity', unique: true, partialFilterExpression: Object.freeze({ forkOf: null }) }),
});

/** The plain `{ from: 1 }` index the swap waits for (see the module header, step 3). */
export const EDGE_FROM_INDEX = Object.freeze({ keys: Object.freeze({ from: 1 } as const), options: Object.freeze({}) });

export type ListedIndex = Document & { name?: string; key?: Record<string, unknown>; unique?: boolean; partialFilterExpression?: unknown };

const edgesOf = (spaceId: string): string => spaceCollection(spaceId, 'edges');

/** The collection's indexes, as the store lists them; a collection that does not exist has none. Anything else the store throws is thrown. */
async function listedIndexes(spaceId: string): Promise<ListedIndex[]> {
  try {
    return await col(edgesOf(spaceId)).listIndexes().toArray() as ListedIndex[];
  } catch (err) {
    if (isNamespaceNotFound(err)) return [];
    throw err;
  }
}

/** Is `ix` a five-key index over exactly the identity fields (any order, any options)? */
const overIdentityFields = (ix: ListedIndex): boolean => {
  const keys = Object.keys(ix.key ?? {});
  return keys.length === Object.keys(EDGE_IDENTITY_KEYS).length && keys.every(k => k in EDGE_IDENTITY_KEYS);
};

/** Is `ix` the partial identity index (five fields, unique, `{ forkOf: null }`)? Matched by shape; the rollback tool drops it by this question. */
export const isPartialIdentity = (ix: ListedIndex): boolean =>
  overIdentityFields(ix) && ix.unique === true && JSON.stringify(ix.partialFilterExpression) === JSON.stringify(EDGE_IDENTITY_INDEX.options.partialFilterExpression);

/** The full unique identity index: five fields, unique, and no partial filter. Matched by shape, never by name. */
const isFullIdentity = (ix: ListedIndex): boolean => overIdentityFields(ix) && ix.unique === true && ix.partialFilterExpression === undefined;

/** Is `ix` the plain `{ from: 1 }` index? The rollback tool drops it by this question. */
export const isFromIndex = (ix: ListedIndex): boolean => {
  const keys = Object.keys(ix.key ?? {});
  return keys.length === 1 && keys[0] === 'from';
};

/** What the edges collection's indexes say about its identity. Throws what the store throws; {@link edgeIdentityAdmitsForks} is the one that fails closed. */
export async function edgeIdentityState(spaceId: string): Promise<{ partial: boolean; full: boolean; from: boolean }> {
  const indexes = await listedIndexes(spaceId);
  return { partial: indexes.some(isPartialIdentity), full: indexes.some(isFullIdentity), from: indexes.some(isFromIndex) };
}

/**
 * May this space store a fork edge: the partial identity index stands and no full unique one does. Read from `listIndexes` on every ask and false on
 * any failure to read (fails closed). One `listIndexes` per call, under the caller's bound.
 */
export async function edgeIdentityAdmitsForks(spaceId: string): Promise<boolean> {
  try {
    const s = await edgeIdentityState(spaceId);
    return s.partial && !s.full;
  } catch {
    return false;
  }
}

/** Step 1: build the partial identity index beside the full one. Idempotent. The one `createIndex` of the swap. */
export async function buildPartialEdgeIdentity(spaceId: string): Promise<void> {
  await col(edgesOf(spaceId)).createIndex({ ...EDGE_IDENTITY_INDEX.keys }, { ...EDGE_IDENTITY_INDEX.options });
}

/** Step 2: confirm the partial identity index from `listIndexes`. Throws when it is absent, so the next step never runs on the strength of a call that returned. */
export async function confirmPartialEdgeIdentity(spaceId: string): Promise<void> {
  const s = await edgeIdentityState(spaceId);
  if (!s.partial) throw new Error(`the partial edge identity index (${EDGE_IDENTITY_INDEX.options.name}) is not in the index list of ${edgesOf(spaceId)} after its build; the full index is kept`);
}

/**
 * Step 3: drop the full unique identity index. Refuses (throws, drops nothing) until the partial index is confirmed AND `{ from: 1 }` stands. Nothing to
 * drop is a done step: the swap of a collection that never had the full index (one built by this release) ends here.
 */
export async function dropFullEdgeIdentity(spaceId: string): Promise<void> {
  const indexes = await listedIndexes(spaceId);
  const full = indexes.filter(isFullIdentity);
  if (full.length === 0) return;
  if (!indexes.some(isPartialIdentity)) throw new Error(`the full edge identity index of ${edgesOf(spaceId)} is kept: the partial one (${EDGE_IDENTITY_INDEX.options.name}) is not confirmed`);
  if (!indexes.some(isFromIndex)) throw new Error(`the full edge identity index of ${edgesOf(spaceId)} is kept: { from: 1 } does not stand, and every read by 'from' would scan once the full index is gone`);
  for (const ix of full) await col(edgesOf(spaceId)).dropIndex(String(ix.name));
}

/** The swap: build beside, confirm, drop the full one. Each step is idempotent, so a swap that stopped anywhere is finished by running it again. */
export async function ensurePartialEdgeIdentity(spaceId: string): Promise<void> {
  await buildPartialEdgeIdentity(spaceId);
  await confirmPartialEdgeIdentity(spaceId);
  await dropFullEdgeIdentity(spaceId);
}

/** Does the edges collection hold no row at all: the case where the swap is free. */
export async function edgesHoldNoRow(spaceId: string): Promise<boolean> {
  return (await col(edgesOf(spaceId)).findOne({}, { projection: { _id: 1 } })) === null;
}

/** Does a unique five-field identity index of either kind stand (the full one, or the partial one)? Throws what the store throws. */
export async function someEdgeIdentityStands(spaceId: string): Promise<boolean> {
  const s = await edgeIdentityState(spaceId);
  return s.partial || s.full;
}
