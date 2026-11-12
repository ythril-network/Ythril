/**
 * Which schema snapshots this server is OWED, and who may hold them (Q-738, bundle-265): the fingerprints records carry that no snapshot row of the
 * space holds. Two sources fill it, and the member's turn drains it (`sync/schema-snapshot-fetch.ts`).
 *
 * ## The two sources
 *
 * - **Arrivals** (`noteOwedSchemaSnapshots`, called by the page accept once a page landed): the distinct stamps of the landed records, in memory, with
 *   the peer that delivered them. One set lookup per page; nothing is read, nothing is fetched, nothing waits. The set is bounded (64 spaces, 256
 *   fingerprints each, the least recently noted dropped), so a restart or an eviction forgets some, and
 * - **the gap scan** (`scanOwedSchemaSnapshots`, the housekeeping step, once a cycle): per space, the fingerprints the STORED records carry
 *   (`distinct`, one unit per record collection, served by the partial index on the stamp) minus the rows held. It refills what the bound dropped,
 *   covers what no arrival noted (a restore, an admin push) and repairs an own snapshot a failed write lost when any member still holds it. The peer is
 *   named from the record's `deliveredBy` (local-only); none (a restore, an admin token) means "any member that shares the space".
 *
 * The trade (R-N6): the owed set is not durable. A restart costs up to one housekeeping cycle before a fingerprint is asked for again, and a stamped
 * record is fully usable meanwhile (the snapshot is needed only to validate it against its writer's schema), so the delay costs latency and nothing else.
 *
 * ## "Nobody holds it"
 *
 * A member that answers `unknown_fingerprint` is dropped from that fingerprint's candidates. When every candidate has said so the fingerprint backs off,
 * doubling from {@link BACKOFF_FIRST_MS} to {@link BACKOFF_MAX_MS}, and the candidates are asked again after it. A record carrying the fingerprint that
 * arrives from a member not yet a candidate resets it: that member may hold it.
 *
 * The empty schema's fingerprint is always known held and has no row: it is never owed.
 */
import { eachSpace, eachUnit } from '../util/housekeeping-walk.js';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { COLLECTION_SUFFIX, KNOWLEDGE_TYPES } from '../config/types-knowledge.js';
import { configuredSpaces } from '../spaces/space-lookup.js';
import { SCHEMA_SNAPSHOT_STEP, type SnapshotRow } from '../spaces/schema-snapshot-store.js';
import { knownHeld, noteHeld, SCHEMA_FINGERPRINT_FIELD } from '../spaces/schema-stamp.js';
import { owedFingerprints } from '../spaces/schema-snapshot.js';

/** The record collections that carry a stamp: every brain collection but `files` (no type, so no schema) and `links` (a link row has no schema). */
export const STAMPED_COLLECTIONS = KNOWLEDGE_TYPES.map(t => COLLECTION_SUFFIX[t]);

/** The most spaces and, per space, fingerprints the in-memory owed set holds; the least recently noted is dropped past either. */
const MAX_SPACES = 64;
const MAX_FINGERPRINTS_PER_SPACE = 256;

/** The first back-off when every candidate said "not held", doubled each time, and its ceiling. */
export const BACKOFF_FIRST_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

/** A schema fingerprint as it is stamped: 64 lowercase hex. */
const FINGERPRINT = /^[0-9a-f]{64}$/;

interface Owed {
  /** The members that delivered a record carrying it. */
  readonly peers: Set<string>;
  /** Some record carrying it has no deliverer a member could be named for (a restore, an admin token): any member sharing the space may hold it. */
  any: boolean;
  /** The members that answered "not held" since the last back-off. */
  readonly notHeld: Set<string>;
  retryAt: number;
  backoffMs: number;
}

/**
 * Insertion-ordered maps, bounded by dropping the first key past the bound: a key noted again is deleted and inserted, so the first is the least
 * recently noted. (`LruMap` hides its order, and the order is what "owed to this member first, in the order noted" reads.)
 */
const owed = new Map<string, Map<string, Owed>>();

function boundedSet<V>(m: Map<string, V>, key: string, value: V, max: number): void {
  m.delete(key);
  m.set(key, value);
  if (m.size > max) m.delete(m.keys().next().value as string);
}

const ofSpace = (spaceId: string): Map<string, Owed> => {
  const m = owed.get(spaceId) ?? new Map<string, Owed>();
  boundedSet(owed, spaceId, m, MAX_SPACES);
  return m;
};

/**
 * Note that `fp` is owed in `spaceId`, delivered by `peerId` (`''`, absent or a restore: any member). A fingerprint that is no stamp, or is known held,
 * is not noted. A new deliverer resets a back-off: that member may hold what the others did not.
 */
export function noteOwedSchemaSnapshot(spaceId: string, fp: unknown, peerId?: string): void {
  if (typeof fp !== 'string' || !FINGERPRINT.test(fp) || knownHeld(spaceId, fp)) return;
  const spaceOwed = ofSpace(spaceId);
  const entry = spaceOwed.get(fp) ?? { peers: new Set<string>(), any: false, notHeld: new Set<string>(), retryAt: 0, backoffMs: 0 };
  if (peerId) {
    if (!entry.peers.has(peerId)) { entry.peers.add(peerId); entry.notHeld.delete(peerId); entry.retryAt = 0; entry.backoffMs = 0; }
  } else entry.any = true;
  // A fingerprint noted again keeps its place in the line: the gap scan notes everything every cycle.
  if (!spaceOwed.has(fp)) boundedSet(spaceOwed, fp, entry, MAX_FINGERPRINTS_PER_SPACE);
}

/**
 * `fp` was asked for and the answer is in, whatever it was: it leaves the line. A fingerprint nobody serves must not stand in front of the ones behind it
 * (four of them would starve every later one of its turn); the gap scan owes it again for as long as a stored record carries it and no row holds it.
 */
export function forgetOwedSchemaSnapshot(spaceId: string, fp: string): void {
  owed.get(spaceId)?.delete(fp);
}

/** {@link noteOwedSchemaSnapshot} for the stamps of a page of landed records: each distinct stamp once, with the peer that delivered the page. */
export function noteOwedSchemaSnapshots(spaceId: string, docs: Iterable<Record<string, unknown>>, peerId?: string): void {
  for (const fp of new Set([...docs].map(d => d[SCHEMA_FINGERPRINT_FIELD]))) noteOwedSchemaSnapshot(spaceId, fp, peerId);
}

/**
 * The fingerprints owed in `spaceId` that `memberId` may be asked for now, the ones owed to it first and then the "any member" ones, each group in the
 * order it was noted: not those it already answered "not held" for, and not those backing off. `candidates` are the members that may be asked at all
 * (they share the space and run a release that serves snapshots): a fingerprint none of whose deliverers is one of them is owed to any of them.
 */
export function owedTo(spaceId: string, memberId: string, candidates: readonly string[], now: number): string[] {
  const mine: string[] = [];
  const anyone: string[] = [];
  for (const [fp, e] of owed.get(spaceId) ?? []) {
    if (e.notHeld.has(memberId) || now < e.retryAt) continue;
    if (e.peers.has(memberId)) mine.push(fp);
    else if (e.any || !candidates.some(c => e.peers.has(c))) anyone.push(fp);
  }
  return [...mine, ...anyone];
}

/** A snapshot of `fp` is held for `spaceId`: nothing is owed for it any more. */
export function dropOwedSchemaSnapshot(spaceId: string, fp: string): void {
  owed.get(spaceId)?.delete(fp);
  noteHeld(spaceId, fp);
}

/**
 * `memberId` answered that it holds no snapshot of `fp`. When every candidate has said so - the members that delivered a record carrying it, or
 * `candidates` (the members that may be asked) when some record has no deliverer - the fingerprint backs off for longer each time.
 */
export function noteNotHeld(spaceId: string, fp: string, memberId: string, candidates: readonly string[], now: number): void {
  const e = owed.get(spaceId)?.get(fp);
  if (!e) return;
  e.notHeld.add(memberId);
  const everyone = e.any || !candidates.some(c => e.peers.has(c)) ? candidates : [...e.peers];
  if (!everyone.every(c => e.notHeld.has(c))) return;
  e.backoffMs = Math.min(Math.max(e.backoffMs * 2, BACKOFF_FIRST_MS), BACKOFF_MAX_MS);
  e.retryAt = now + e.backoffMs;
  e.notHeld.clear();
}

/** Forget everything owed, for tests. */
export function forgetOwedSchemaSnapshots(): void { owed.clear(); }

/** The most fingerprints one space's scan names: the in-memory set holds no more, and the next cycle's scan names the rest. */
const SCAN_PER_SPACE = MAX_FINGERPRINTS_PER_SPACE;

/**
 * The housekeeping step's body: for every space, owe each fingerprint a stored record carries and no snapshot row holds, naming the peer that delivered
 * the record when it has one. A collection whose `distinct` fails is reported under the step and the rest are read (`eachUnit`); a store that is not
 * answering ends the space.
 */
export async function scanOwedSchemaSnapshots(): Promise<void> {
  await eachSpace(SCHEMA_SNAPSHOT_STEP, configuredSpaces(), async (space) => {
    const carriedIn = new Map<string, (typeof STAMPED_COLLECTIONS)[number]>();
    await eachUnit(STAMPED_COLLECTIONS, async (collection) => {
      const found = await col<Record<string, unknown>>(spaceCollection(space.id, collection))
        .distinct(SCHEMA_FINGERPRINT_FIELD, asFilter<Record<string, unknown>>({ [SCHEMA_FINGERPRINT_FIELD]: { $exists: true } }));
      for (const fp of found) if (typeof fp === 'string' && FINGERPRINT.test(fp) && !carriedIn.has(fp)) carriedIn.set(fp, collection);
    });
    const carried = [...carriedIn.keys()].filter(fp => !knownHeld(space.id, fp));
    if (carried.length === 0) return;
    const rows = col<SnapshotRow>(spaceCollection(space.id, 'schemaSnapshots'));
    const held = new Set<string>();
    for (let i = 0; i < carried.length; i += 500) {
      for (const r of await rows.find(asFilter<SnapshotRow>({ _id: { $in: carried.slice(i, i + 500) } }), { projection: { _id: 1 } }).toArray()) held.add(String(r._id));
    }
    for (const fp of held) noteHeld(space.id, fp);
    for (const fp of owedFingerprints(carried, held).slice(0, SCAN_PER_SPACE)) {
      const from = await col<Record<string, unknown>>(spaceCollection(space.id, carriedIn.get(fp)!))
        .findOne(asFilter<Record<string, unknown>>({ [SCHEMA_FINGERPRINT_FIELD]: fp }), { projection: { deliveredBy: 1 } });
      const deliveredBy = from?.['deliveredBy'];
      noteOwedSchemaSnapshot(space.id, fp, typeof deliveredBy === 'string' ? deliveredBy : undefined);
    }
  });
}
