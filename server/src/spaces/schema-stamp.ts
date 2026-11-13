/**
 * The schema fingerprint a record is stamped with, and the meta it was checked against, read TOGETHER (Q-734, Q-736, bundle-265).
 *
 * ## What it prevents
 *
 * A record stamped with `schemaFingerprint` claims it conforms, as stored, to the schema with that fingerprint. A writer that read the meta to
 * validate with and, later, asked for the fingerprint separately could stamp a record with a schema a concurrent meta write stored between the
 * two reads, which the record was never checked against. Here the pair is one synchronous read (`readMetaForWrite`): `meta` is what the write
 * validates with (the stored meta with its library `$ref`s resolved, the form `getSpaceMeta` answers) and `stamp` is the fingerprint and text
 * of the very stored object `meta` was made from. The stamping op is computed from that pair and the write's own check (`stampOp`), so a meta
 * of another provenance cannot be handed in, and it THROWS on a pair with no stamp (a hand-built one) instead of writing nothing.
 *
 * ## What a fingerprint is
 *
 * `sha256(utf8(T))`, `T = schemaFingerprintTextOf(inlineResolvableRefs(stored))` (`@ythril-network/schema/internal`): the schema alone, keys
 * sorted, empty kinds left out, every resolvable library `$ref` inlined. No meta and an empty meta are the empty schema, which has a fixed
 * fingerprint (stored stamps outlive a build). A server's VARIATION of a space is its effective meta (own definitions laid under each network's
 * layer); a variation that adds nothing to a layer has the layer's text, so it has the layer's fingerprint by content, with no rule.
 *
 * ## The memo
 *
 * Making `T` costs milliseconds on a large meta and every write asks. It is memoised on the STORED object (a meta write stores a new one, so a
 * changed schema is a miss) and checked against the library: the memo keeps the library definition each `$ref` resolved to, and a definition
 * that is no longer the same object (every library save stores new entry objects) is a miss. A space that holds no `$ref` never reads the library.
 *
 * ## What else lives here
 *
 * The bounded set of fingerprints known to have a snapshot row (`knownHeld`), so the per-write backstop costs no I/O after the first write of a
 * fingerprint. A content-addressed row's text never changes; the row goes only when the snapshot sweep removes it, and the sweep forgets it here
 * first (`forgetHeld`, which moves the space's `heldGeneration` so a write in flight cannot note it held again). And `variationOf`, what the snapshot writer
 * keeps for a space (`schema-snapshot-store.ts`): the variation's stamp, each layer's, and the links between them.
 *
 * Imports `getConfig` and the two ref resolvers in one direction: `schema-validation.ts` imports nothing from here, so `getSpaceMeta` is untouched
 * and no import cycle forms.
 */
import { schemaFingerprintTextOf, SCHEMA_FINGERPRINT_FIELD, isSchemaFingerprint } from '@ythril-network/schema/internal';
import type { SpaceMeta, TypeSchema } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { inlineResolvableRefs, resolveMetaRefs, resolveTypeSchema } from './schema-validation.js';
import { servedMetaFor } from '../sync/replicated-meta.js';
import { layersFor } from './network-layers.js';
import { findSpace } from './space-lookup.js';
import { LruMap } from '../util/lru-map.js';
import { KeyGenerations } from '../util/key-generations.js';
import { log, peerText } from '../util/log.js';
import { sha256Hex } from '../util/sha256-hex.js';

/** A schema version: its fingerprint and the canonical text the fingerprint is the hash of. */
export interface Stamp {
  readonly fp: string;
  readonly text: string;
}

/** What a write validates with, and the stamp of the stored meta that came from: one read, never two. */
export interface MetaForWrite {
  readonly meta: SpaceMeta | undefined;
  readonly stamp: Stamp;
}

/** What a write's schema check answered, as far as the stamp needs it: a record conforms when the check found nothing. */
export interface SchemaCheckOutcome {
  readonly all: readonly unknown[];
}

/** The field a record carries its stamp in: spelled once, in `@ythril-network/schema` (`schema-fingerprint.ts`), and re-exported here for the writers. */
export { SCHEMA_FINGERPRINT_FIELD, isSchemaFingerprint };

/** How a log line names a schema fingerprint: its first 12 hex characters, the one length every line uses, so a grep for one finds them all. */
export const fpPrefix = (fp: string): string => fp.slice(0, 12);

/** The op that removes the stamp: what every write spreads that changes schema-relevant content without a conforming validation. */
export const UNSTAMP: { readonly $unset: { readonly [SCHEMA_FINGERPRINT_FIELD]: '' } } = Object.freeze({ $unset: Object.freeze({ [SCHEMA_FINGERPRINT_FIELD]: '' as const }) });

/** `$set` of the stamp when the written record conforms, else {@link UNSTAMP}. */
export type StampOp = { readonly $set: { readonly [SCHEMA_FINGERPRINT_FIELD]: string } } | typeof UNSTAMP;

interface Memo {
  /** Each stored `$ref` type and the library definition it resolved to when the stamp was made. */
  readonly refs: ReadonlyArray<readonly [TypeSchema, TypeSchema | undefined]>;
  readonly stamp: Stamp;
}

const memo = new WeakMap<object, Memo>();

const stampOfText = (text: string): Stamp => Object.freeze({ fp: sha256Hex(text), text });

/**
 * The empty schema: no meta at all, and one with no type and no rule. Its text is held on every instance with no row anywhere; every reader
 * of that text (the version reads, the sync door) reads it here, never spells `schemaFingerprintTextOf(undefined)` again.
 */
const EMPTY: Stamp = stampOfText(schemaFingerprintTextOf(undefined));
export { EMPTY as EMPTY_SCHEMA_STAMP };

/** The stored `$ref` types of a meta, each with what it resolves to now. */
function refsOf(stored: SpaceMeta): Array<readonly [TypeSchema, TypeSchema | undefined]> {
  const out: Array<readonly [TypeSchema, TypeSchema | undefined]> = [];
  for (const types of Object.values(stored.typeSchemas ?? {})) {
    for (const schema of Object.values(types ?? {}) as TypeSchema[]) if (schema?.$ref) out.push([schema, resolveTypeSchema(schema)]);
  }
  return out;
}

/** The stamp of a STORED meta object (an effective meta, a stored layer, an own meta): memoised on the object and checked against the library. */
function stampOf(stored: SpaceMeta | undefined): Stamp {
  if (!stored) return EMPTY;
  const held = memo.get(stored);
  if (held && held.refs.every(([schema, resolved]) => resolveTypeSchema(schema) === resolved)) return held.stamp;
  const refs = refsOf(stored);
  const stamp = stampOfText(schemaFingerprintTextOf(inlineResolvableRefs(stored)));
  memo.set(stored, { refs, stamp });
  return stamp;
}

/** The stored meta of `spaceId`, read once. */
const storedMetaOf = (spaceId: string): SpaceMeta | undefined => findSpace(spaceId)?.meta;

/**
 * The meta a write of `spaceId` validates with and the stamp it may write, from ONE synchronous read of the stored meta. `meta` is
 * `undefined` for a space with no schema, and the stamp is then the empty schema's.
 */
export function readMetaForWrite(spaceId: string): MetaForWrite {
  const stored = storedMetaOf(spaceId);
  const write: MetaForWrite = { meta: stored ? resolveMetaRefs(stored) : undefined, stamp: stampOf(stored) };
  spaceOfWrite.set(write, spaceId);
  return write;
}

/**
 * The fingerprint of a configured space's variation now, from the stored meta it holds: what GET meta and `space_meta` answer as
 * `schemaFingerprint`, the same one `readMetaForWrite` stamps with.
 */
export function schemaFingerprintOf(space: { readonly meta?: SpaceMeta } | undefined): string {
  return stampOf(space?.meta).fp;
}

// ── The op a write spreads ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Which space a pair was read for, so the backstop below knows where to keep its snapshot without a third field on the pair. */
const spaceOfWrite = new WeakMap<MetaForWrite, string>();

/**
 * The per-write backstop's call into the snapshot writer, which imports this module: a static import back would be a runtime cycle, so the writer is
 * imported when a stamp first needs it (once; the module is cached after). Never a hook the writer installs as a side effect of being imported: such a
 * hook was called with `?.`, so a process that had not loaded the writer stamped records whose snapshot nobody kept, and said nothing. A writer that
 * cannot be loaded is a broken build, said at error.
 */
function keepStampedSnapshotLater(spaceId: string, stamp: Stamp): void {
  void import('./schema-snapshot-store.js').then(store => store.keepStampedSnapshot(spaceId, stamp),
    (err: unknown) => log.error(`Schema snapshot writer could not be loaded, so the snapshot of fingerprint ${peerText(fpPrefix(stamp.fp))} of space '${peerText(spaceId)}' `
      + `was not kept: ${peerText(err)}`));
}

/**
 * The op a validating write spreads into its update: `$set` of the pair's fingerprint when the check found nothing (the written record
 * conforms as stored), {@link UNSTAMP} otherwise. An insert that does not conform simply carries no field.
 *
 * The per-write backstop rides here: a stamp whose fingerprint has no known snapshot row schedules one, detached, from the very text it
 * stamped with, so the snapshot a record names is kept even when the schema has moved on since.
 *
 * @throws when `write` carries no stamp: a pair that did not come from {@link readMetaForWrite} would write nothing and say nothing.
 */
export function stampOp(write: MetaForWrite, check: SchemaCheckOutcome): StampOp {
  if (!write?.stamp?.fp) {
    throw new Error('stampOp: the meta it was handed carries no stamp. A write stamps only from the pair readMetaForWrite(spaceId) answered, '
      + 'so the fingerprint is the one of the schema the record was checked against.');
  }
  if (check.all.length > 0) return UNSTAMP;
  const spaceId = spaceOfWrite.get(write);
  if (spaceId !== undefined && !knownHeld(spaceId, write.stamp.fp)) keepStampedSnapshotLater(spaceId, write.stamp);
  return { $set: { [SCHEMA_FINGERPRINT_FIELD]: write.stamp.fp } } as StampOp;
}

/**
 * {@link stampOp} for a write that lands on a version it re-read (`writeAtReadVersion`): the stamp only when the stored version the write
 * lands on is the one the check validated (`at.readSeq === validatedSeq`). A row that moved in between is written without a conforming
 * validation of what it lands on, so the stamp is removed (DI-4).
 */
export function stampOpIfUnmoved(at: { readonly readSeq: number | null }, validatedSeq: number | null, write: MetaForWrite, check: SchemaCheckOutcome): StampOp {
  if (at.readSeq !== validatedSeq) {
    if (!write?.stamp?.fp) return stampOp(write, check);   // the same refusal of a hand-built pair
    return UNSTAMP;
  }
  return stampOp(write, check);
}

/**
 * Fold `op` into the `$set` and `$unset` a write builds, taking the field out of the other one, so the stamp is never set and unset by one
 * write (Mongo refuses that) and a retried attempt replaces what an earlier attempt folded in.
 */
export function foldStampOp(op: StampOp, $set: Record<string, unknown>, $unset: Record<string, unknown>): void {
  if ('$set' in op) {
    $set[SCHEMA_FINGERPRINT_FIELD] = op.$set[SCHEMA_FINGERPRINT_FIELD];
    delete $unset[SCHEMA_FINGERPRINT_FIELD];
  } else {
    $unset[SCHEMA_FINGERPRINT_FIELD] = '';
    delete $set[SCHEMA_FINGERPRINT_FIELD];
  }
}

/** What `op` sets, as a map a write spreads (empty for {@link UNSTAMP}). */
export const stampSetOf = (op: StampOp): Readonly<Record<string, string>> => ('$set' in op ? op.$set : {});

/** What `op` removes, as a map a write's `$unset` spreads (empty for a stamp); its keys are what a re-key takes as `alsoUnset`. */
export const stampUnsetOf = (op: StampOp): Readonly<Record<string, ''>> => ('$unset' in op ? op.$unset : {});

/**
 * The record a write ANSWERS with, carrying the stamp as the write's folded `$set`/`$unset` left it: the stored stamp when one was set, none
 * when it was removed. An answer built from the record as read would otherwise name a stamp the write just took away.
 */
export function carryStamp<T extends object>(answer: T, $set: Readonly<Record<string, unknown>>, $unset: Readonly<Record<string, unknown>>): T {
  const out = answer as Record<string, unknown>;
  if (SCHEMA_FINGERPRINT_FIELD in $set) out[SCHEMA_FINGERPRINT_FIELD] = $set[SCHEMA_FINGERPRINT_FIELD];
  else if (SCHEMA_FINGERPRINT_FIELD in $unset) delete out[SCHEMA_FINGERPRINT_FIELD];
  return answer;
}

// ── What the snapshot writer keeps for a space ──────────────────────────────────────────────────────────────────────────────────────────

/** What a snapshot of a variation was built from: its own definitions, each layer it received, and what it serves each network. */
export interface SnapshotLinks {
  own: string;
  layers: { networkId: string; fp: string }[];
  served: { networkId: string; fp: string }[];
}

/** A space's variation now: its stamp, the links of its snapshot, and each network layer's own stamp. */
export interface Variation {
  stamp: Stamp;
  links: SnapshotLinks;
  layers: { networkId: string; stamp: Stamp }[];
}

/** The variation of `spaceId` as the config holds it now, or `undefined` for a space that is not configured. */
export function variationOf(spaceId: string): Variation | undefined {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) return undefined;
  const layers = layersFor(cfg, spaceId).map(l => ({ networkId: l.networkId, meta: l.meta as SpaceMeta }));
  const own = space.ownMeta ?? space.meta;
  return {
    stamp: stampOf(space.meta),
    links: {
      own: stampOf(own).fp,
      layers: layers.map(l => ({ networkId: l.networkId, fp: stampOf(l.meta).fp })),
      served: layers.map(l => ({ networkId: l.networkId, fp: stampOf(servedMetaFor(space, l)).fp })),
    },
    layers: layers.map(l => ({ networkId: l.networkId, stamp: stampOf(l.meta) })),
  };
}

/** The stamp of one stored network layer (what `storeNetworkLayer` just stored). */
export function layerStampOf(layer: SpaceMeta): Stamp {
  return stampOf(layer);
}

// ── The fingerprints known to have a snapshot row ───────────────────────────────────────────────────────────────────────────────────────

/** The most fingerprints remembered per space; the oldest noted is forgotten past it, and the next write of it asks the store again. */
const HELD_PER_SPACE = 256;
const held = new Map<string, LruMap<string, true>>();

/** The empty schema's fingerprint: what a space with no type and no rule stamps with. */
export const EMPTY_SCHEMA_FINGERPRINT = EMPTY.fp;

/**
 * Is a snapshot of `fp` known to be held for `spaceId`? `false` is "not known", never "absent". The empty schema is always held, by every
 * instance and with no row: its text is fixed, so a space that never had a schema keeps nothing and no member ever needs to fetch it.
 */
export function knownHeld(spaceId: string, fp: string): boolean {
  return fp === EMPTY.fp || held.get(spaceId)?.peek(fp) === true;
}

/** Record that `spaceId` holds a snapshot row of `fp` (it was written, or found): the most recently noted, the oldest forgotten past the bound. */
export function noteHeld(spaceId: string, fp: string): void {
  let known = held.get(spaceId);
  if (!known) held.set(spaceId, known = new LruMap<string, true>(HELD_PER_SPACE));
  known.set(fp, true);
}

/**
 * Forget what is known of `spaceId`'s rows (its collection was dropped or renamed away), or of one row of it (the sweep removed it). Each call moves
 * the space's {@link heldGeneration}, so a write that started before it cannot note the row held after it.
 */
export function forgetHeld(spaceId: string, fp?: string): void {
  generations.bump(spaceId);
  if (fp === undefined) held.delete(spaceId);
  else held.get(spaceId)?.delete(fp);
}

/** How many times {@link forgetHeld} ran for each space: one number per configured space ever seen, never reset. */
const generations = new KeyGenerations();

/**
 * The space's held generation: a writer reads it before its upsert and notes the row held after it only when it has not moved. Otherwise a keep in
 * flight while the sweep removed the row (and forgot it) would mark the removed row held, and the backstop and the gap scan would skip it for the life
 * of the process (bundle-266, design r3 S-5).
 */
export function heldGeneration(spaceId: string): number {
  return generations.of(spaceId);
}
