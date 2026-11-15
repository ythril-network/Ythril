/**
 * Where each schema version the records of a collection carry stands against one anchor version, per type: THE pass the older mark, the
 * filter's `older` and `sameAs:<fp>`, a type's history and the drawer's standing all read (bundle-268, Q-744 design r3 §1, §3, §5; r4 §2).
 *
 * ## The question it answers
 *
 * "Which of these stamps would a record of type T see differently from the anchor?" {@link standingsOf} answers it for a list of stamps,
 * {@link kindStandingsIn} for every stamp a collection's records carry (R1), and {@link notSameFor} names, for one type, THE set of stamps
 * both the older mark and the `older` filter read, so the two are equal by construction. A stamp stands as one {@link KindStanding}:
 *
 * - `same`: no type of the kind changed (or none counted under the mode);
 * - a set of type names: those of the kind that changed;
 * - `all`: every type of the kind changed (a space rule over the kind, the kind's allowlist);
 * - `unclassified`: a place either text could not read, or (in {@link kindStandingsIn}) a record of the stamp whose type is neither a
 *   string nor absent (R2: the shipped `unnamed` rule);
 * - `notHeld`: no text here, or not one this caller may have (`mayHave`, the sync door's `servableTo`).
 *
 * ## What it prevents (kept inside, so no caller can drop it)
 *
 * - **A caller's scope left out.** {@link PassScope} is a required argument: a peer-bound token's pass never reads a text it may not have,
 *   so a version built from a network it is not in stands `notHeld` for it, whatever its text says.
 * - **An empty answer for a failed read.** Every read throws; a missing stamp index is `SchemaIndexBuilding` (503), and the store's own
 *   `MaxTimeMSExpired`, like a spent deadline, is {@link SchemaVersionsBusy} (503, a fixed sentence): never "no stamp".
 * - **A pass that holds the event loop or the heap.** The deadline is asked before every read and every diff, the loop gets a turn after
 *   every {@link PASS_SLICE_MS} of diffing, and the misses' texts are read in chunks of at most {@link TEXT_CHUNK} texts and
 *   {@link TEXT_CHUNK_BYTES} bytes, each dropped once classified. The anchor's text is read once per pass.
 * - **Work done twice.** A classified standing is kept in the standing memo, keyed by (space, kind, anchor, mode): a fingerprint names its
 *   text, so an entry never goes stale, and what a busy pass classified is kept for the retry. `notHeld` and R2 are never memoised: holdings
 *   and records change.
 */
import { col } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { isMaxTimeExpired } from '../db/max-time.js';
import { timeLeftUntil } from '../db/read-by-id.js';
import { LruMap } from '../util/lru-map.js';
import { yieldToEventLoop } from '../util/yield-to-event-loop.js';
import { SchemaVersionsBusy } from '../util/errors.js';
import { servableTo } from './schema-snapshot.js';
import { configuredVersions, heldVersionsKept, versionTexts, type HeldProvenance } from './schema-version-text.js';
import { parsedVersion, typesDifferingUnder, type ParsedVersion, type SchemaChangedMode, type TypesDiffering } from './schema-diff.js';
import {
  fingerprintsCarriedIn, unnamedFingerprintsIn, stampPlanOf, stampedKindOf, FINGERPRINT_TYPES_DEFAULT_MS, type StampedCollection, type StampPlan,
} from './schema-snapshot-carried.js';

/** Where one stamp stands against the anchor for the records of one kind: see the module docblock. */
export type KindStanding = 'same' | 'all' | 'unclassified' | 'notHeld' | ReadonlySet<string>;

/** What a classified pair of texts says for one kind: every {@link KindStanding} but `notHeld`, which no text decides. */
type ClassifiedStanding = Exclude<KindStanding, 'notHeld'>;

/** Who the pass is for and until when: the networks a peer-bound caller shares the space in (`undefined`: a local caller), and its deadline. */
export interface PassScope {
  readonly shared: ReadonlySet<string> | undefined;
  readonly timeLeft: () => number;
}

/** A pass's whole budget: the version list's (`FINGERPRINT_TYPES_DEFAULT_MS`, 10 s). */
export const SCHEMA_PASS_MS = FINGERPRINT_TYPES_DEFAULT_MS;
/** Milliseconds of diffing between two turns given to the event loop. */
export const PASS_SLICE_MS = 25;
/** The most texts one read of the misses asks for. */
export const TEXT_CHUNK = 16;
/** The most bytes of text one read of the misses asks for; a single text over it is a chunk of its own (the snapshot cap is 10 MB). */
export const TEXT_CHUNK_BYTES = 8 * 1024 * 1024;

/** The deadline of one request's pass over `spaceId`: `ms` from now, {@link SchemaVersionsBusy} once spent. */
export function passTimeLeft(spaceId: string, ms: number = SCHEMA_PASS_MS): () => number {
  const at = Date.now() + ms;
  return timeLeftUntil(() => at - Date.now(), () => new SchemaVersionsBusy(spaceId));
}

/** May the caller have this held version? Every version for a local caller; for a peer-bound one, what the sync door would serve it. */
export const mayHave = (v: HeldProvenance, shared: ReadonlySet<string> | undefined): boolean => !shared || !v.kept || servableTo(v.kept, shared).ok;

/** The key a scope is told apart by: two scopes see different holdings, so they never share a flight or a class memo entry. */
export const scopeKeyOf = (shared: ReadonlySet<string> | undefined): string => (shared ? `shared:${[...shared].sort().join(',')}` : 'local');

/**
 * `fn`, with the store's `MaxTimeMSExpired` answered as {@link SchemaVersionsBusy}: the one mapping every read of a pass goes through, so a
 * deadline the store enforced and one the pass enforced say the same fixed sentence, and the store's own words never reach a caller.
 */
export async function busyOnTimeout<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMaxTimeExpired(err)) throw new SchemaVersionsBusy(spaceId);
    throw err;
  }
}

/** The counted work of every pass since the process started (T5 asserts work, never time). */
const work = { textsRead: 0, textsParsed: 0, diffs: 0 };

/** The texts read from the store, the texts parsed and the diffs made by every standing pass since the process started. */
export function standingWork(): { textsRead: number; textsParsed: number; diffs: number } {
  return { ...work };
}

/** The weight of one memo entry in bytes: a fixed cost per stamp, and the changed type names it keeps. */
function weighStandings(m: ReadonlyMap<string, ClassifiedStanding>): number {
  let bytes = 0;
  for (const s of m.values()) {
    bytes += 64;
    if (typeof s !== 'string') for (const name of s) bytes += 2 * name.length;
  }
  return Math.max(1, bytes);
}

/**
 * The standing memo: per (space, kind, anchor, mode), each classified stamp's standing. 512 entries and 32 MiB (design r3 §5.3: 5,000
 * versions with one changed type each weigh about 0.5 MiB). One entry is one whole pass, so a pass hits or misses as one unit.
 */
const standingMemo = new LruMap<string, Map<string, ClassifiedStanding>>(512, undefined, { weigh: weighStandings, maxWeight: 32 * 1024 * 1024 });

/** What one kind's records see of a classified pair. */
function kindStandingOf(td: TypesDiffering, kind: string): ClassifiedStanding {
  if (td.unclassified) return 'unclassified';
  const k = td.kinds.get(kind);
  if (k === undefined) return 'same';
  if (k === 'all') return 'all';
  return k.size === 0 ? 'same' : k;
}

/** The byte size of each of `fps`'s texts, read without the texts: from the config for a version it holds, else one aggregate of the rows. */
async function textSizesOf(spaceId: string, fps: readonly string[], timeLeft: () => number): Promise<Map<string, number>> {
  const configured = configuredVersions(spaceId);
  const sizes = new Map<string, number>();
  const toAsk: string[] = [];
  for (const fp of fps) {
    const v = configured.get(fp);
    if (v) sizes.set(fp, Buffer.byteLength(v.text, 'utf8')); else toAsk.push(fp);
  }
  if (toAsk.length === 0) return sizes;
  const rows = await col<{ _id: string; b: number }>(spaceCollection(spaceId, 'schemaSnapshots')).aggregate<{ _id: string; b: number }>([
    { $match: { _id: { $in: toAsk }, text: { $type: 'string' } } },
    { $project: { b: { $strLenBytes: '$text' } } },
  ], { maxTimeMS: timeLeft() }).toArray();
  for (const r of rows) sizes.set(String(r._id), r.b);
  return sizes;
}

/** `fps` in chunks of at most {@link TEXT_CHUNK} texts and {@link TEXT_CHUNK_BYTES} bytes; a text over the bytes alone is a chunk of its own. */
function textChunksOf(fps: readonly string[], sizes: ReadonlyMap<string, number>): string[][] {
  const out: string[][] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const fp of fps) {
    const b = sizes.get(fp) ?? 0;
    if (chunk.length > 0 && (chunk.length >= TEXT_CHUNK || bytes + b > TEXT_CHUNK_BYTES)) { out.push(chunk); chunk = []; bytes = 0; }
    chunk.push(fp);
    bytes += b;
  }
  if (chunk.length > 0) out.push(chunk);
  return out;
}

/**
 * THE chunker of every pass that reads many version texts (the standing pass and a type's history): `fps` in chunks of at most {@link TEXT_CHUNK}
 * texts and {@link TEXT_CHUNK_BYTES} bytes, sized from the config and one aggregate of the rows, never from the texts. What it prevents: a
 * reader that bounds a read by count alone, which with 19 KB texts is 300 KB and with the snapshot cap's 10 MB texts is 160 MB in one reply.
 * One text (or none) needs no sizing: it is a chunk of its own.
 */
export async function textChunksFor(spaceId: string, fps: readonly string[], timeLeft: () => number): Promise<string[][]> {
  if (fps.length <= 1) return fps.length === 0 ? [] : [[...fps]];
  return textChunksOf(fps, await textSizesOf(spaceId, fps, timeLeft));
}

/** The anchor's text, read once for a pass: from the config when it holds it, else from its row. `null` when neither holds it. */
async function anchorTextOf(spaceId: string, anchor: string, timeLeft: () => number): Promise<ParsedVersion | null> {
  const configured = configuredVersions(spaceId).get(anchor);
  let text = configured?.text;
  if (text === undefined) {
    text = (await versionTexts(spaceId, [anchor], { timeLeft })).get(anchor);
    if (text !== undefined) work.textsRead++;
  }
  if (text === undefined) return null;
  work.textsParsed++;
  return parsedVersion(text);
}

/**
 * Where each of `fps` stands against `anchor` for the records of `collection`, under `mode`, for the caller `scope` names: `notHeld` for a
 * stamp this server holds no text of or the caller may not have (and for every stamp when the anchor is such a one: `anchorHeld` false).
 * The anchor itself is never placed. R2 is not asked here ({@link kindStandingsIn} asks it). Throws on any failure.
 */
export async function standingsOf(
  spaceId: string, collection: StampedCollection, anchor: string, mode: SchemaChangedMode, scope: PassScope, fps: readonly string[],
): Promise<{ anchorHeld: boolean; fps: Map<string, KindStanding> }> {
  return busyOnTimeout(spaceId, async () => {
    const kind = stampedKindOf(collection);
    const others = [...new Set(fps)].filter(fp => fp !== anchor);
    const out = new Map<string, KindStanding>();
    const held = await heldVersionsKept(spaceId, [anchor, ...others], { timeLeft: scope.timeLeft });
    const anchorRow = held.get(anchor);
    if (!anchorRow || !mayHave(anchorRow, scope.shared)) {
      for (const fp of others) out.set(fp, 'notHeld');
      return { anchorHeld: false, fps: out };
    }
    const key = `${spaceId}|${kind}|${anchor}|${mode}`;
    let memo = standingMemo.get(key);
    if (!memo) { memo = new Map(); standingMemo.set(key, memo); }
    const misses: string[] = [];
    for (const fp of others) {
      const v = held.get(fp);
      if (!v || !mayHave(v, scope.shared)) { out.set(fp, 'notHeld'); continue; }
      const known = memo.get(fp);
      if (known !== undefined) out.set(fp, known); else misses.push(fp);
    }
    if (misses.length === 0) return { anchorHeld: true, fps: out };
    try {
      const anchorText = await anchorTextOf(spaceId, anchor, scope.timeLeft);
      if (!anchorText) {
        for (const fp of misses) out.set(fp, 'notHeld');
        return { anchorHeld: false, fps: out };
      }
      let slice = Date.now();
      for (const chunk of await textChunksFor(spaceId, misses, scope.timeLeft)) {
        const texts = await versionTexts(spaceId, chunk, { timeLeft: scope.timeLeft });
        work.textsRead += texts.size;
        for (const fp of chunk) {
          const text = texts.get(fp);
          // A row the sweep removed between the held read and this one: not held now.
          if (text === undefined) { out.set(fp, 'notHeld'); continue; }
          scope.timeLeft();
          work.textsParsed++;
          const from = parsedVersion(text);
          work.diffs++;
          const standing = kindStandingOf(typesDifferingUnder(from, anchorText, mode), kind);
          memo.set(fp, standing);
          out.set(fp, standing);
          if (Date.now() - slice >= PASS_SLICE_MS) { await yieldToEventLoop(); slice = Date.now(); }
        }
      }
    } finally {
      // Set again to re-weigh what this pass added, busy or not: a retry continues from here.
      standingMemo.set(key, memo);
    }
    return { anchorHeld: true, fps: out };
  });
}

/** What {@link kindStandingsIn} answers: the anchor held for the caller, each carried stamp's standing, and the pass's stamp plan (hint, multikey answer). */
export interface KindStandings {
  readonly anchorHeld: boolean;
  readonly fps: ReadonlyMap<string, KindStanding>;
  readonly plan: StampPlan;
}

/**
 * Every stamp the records of `collection` carry (R1), placed against `anchor` ({@link standingsOf}), and each one a record of which has a type
 * that is neither a string nor absent made `unclassified` (R2, the shipped `unnamed` rule). Throws on any failure.
 */
export async function kindStandingsIn(
  spaceId: string, collection: StampedCollection, anchor: string, mode: SchemaChangedMode, scope: PassScope,
): Promise<KindStandings> {
  return busyOnTimeout(spaceId, async () => {
    const plan = await stampPlanOf(spaceId, collection);
    const carried = await fingerprintsCarriedIn(spaceId, collection, undefined, { timeLeft: scope.timeLeft, plan });
    const { anchorHeld, fps } = await standingsOf(spaceId, collection, anchor, mode, scope, carried);
    const ask = [...fps].filter(([, s]) => s !== 'notHeld' && s !== 'unclassified').map(([fp]) => fp);
    for (const fp of await unnamedFingerprintsIn(spaceId, collection, ask, scope.timeLeft, { plan })) fps.set(fp, 'unclassified');
    return { anchorHeld, fps, plan };
  });
}

/** Does a record of `type` see a stamp that stands `s` differently from the anchor? Every standing but `same` and a set without the type. */
export const notSameStanding = (s: KindStanding, type: string): boolean => (typeof s === 'string' ? s !== 'same' : s.has(type));

/**
 * The stamps whose records of `type` stand not-`same` against the anchor: those that are `all`, `unclassified` or `notHeld`, and those whose
 * changed set holds the type. THE set both the `older` filter and the older mark read (design r4 §3.3).
 */
export function notSameFor(fps: ReadonlyMap<string, KindStanding>, type: string): string[] {
  return [...fps].filter(([, s]) => notSameStanding(s, type)).map(([fp]) => fp).sort();
}
