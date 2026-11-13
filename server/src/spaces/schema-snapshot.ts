/**
 * The decisions of the schema snapshot fetch, as pure functions of their arguments (Q-738, bundle-265): which row a peer may be served, whether a fetched
 * text is the snapshot its fingerprint names, which fingerprints a space owes, and whether this variation is behind a sender's. No store, no peer and no
 * clock is read here, so each is tested with literals (`a-schema-snapshot-decisions-are-pure-functions`); the route (`api/sync/schema-snapshot.ts`) and the
 * receiver (`sync/schema-snapshot-fetch.ts`) call them and do the I/O.
 *
 * ## What each one prevents
 *
 * - {@link servableTo}: a snapshot that names another network's definitions reaching a member of this network only (F-39.2, "nothing mixed is sent
 *   on"). A variation built over a layer of N2 holds N2's definitions, which the sync door's `GET /api/sync/meta` never sends to N1; its snapshot must not either.
 * - {@link verifySnapshot}: a peer's text kept as a snapshot because it says so. It is kept only when it is the canonical text its fingerprint is the
 *   hash of, so what a fingerprint names is the same text on every instance.
 * - {@link owedFingerprints}: a fingerprint asked for twice, or asked for after a row holds it.
 * - {@link behindVerdict}: "my variation is behind" read from a sender's links as a HINT (S-N3): a peer's claim, so the caller logs and counts it and keeps
 *   nothing because of it.
 * - {@link snapshotSweepPlan}: a version a stored record carries, or one a kept version links, being removed by the sweep (bundle-266, Q-739).
 */
import { isSchemaFingerprint, schemaFingerprintTextOf, isPlainObject } from '@ythril-network/schema/internal';
import { readPeerMeta } from './body-schemas.js';
import type { SnapshotLinks } from './schema-stamp.js';
import { JSON_BODY_MAX_BYTES } from '../config/body-limits.js';
import { sha256Hex } from '../util/sha256-hex.js';

/**
 * The largest snapshot text a peer takes: a schema that came in through a JSON body is at most that body's limit. A larger text (library
 * inlining can grow one) is still kept by its writer, and said once; peers refuse to fetch it. Here, in the pure module, so the receiver's
 * refusal does not load the store to read a number.
 */
export const SCHEMA_SNAPSHOT_MAX_BYTES = JSON_BODY_MAX_BYTES;

/** Is `text` larger than a peer takes? In UTF-8 bytes, never `length` (a letter can be two): the one test of the cap, for the writer's note and the receiver's refusal. */
export const isOverSnapshotCap = (text: string): boolean => Buffer.byteLength(text, 'utf8') > SCHEMA_SNAPSHOT_MAX_BYTES;

/** The fields of a snapshot row the route decides on: how this server came to hold it, the network of a layer row, and what it was built from. */
export interface ServableRow {
  readonly origin: 'own' | 'layer' | 'fetched';
  readonly networkId?: string;
  readonly links: SnapshotLinks | null;
}

/** May this row be served on, and with which links: they are cut to the shared networks, never changed in place. */
export type Servable = { ok: true; links: SnapshotLinks | null } | { ok: false; code: 'not_shared' };

const cutTo = (list: SnapshotLinks['layers'], shared: ReadonlySet<string>): SnapshotLinks['layers'] => list.filter(l => shared.has(l.networkId));

/**
 * May `row` be served to a peer that holds the space in `shared` networks with this server?
 *
 * The networks a row was built from are `networkId` for a layer row and the networks its links name for any other. Any of them outside `shared` is
 * `not_shared`. A row whose provenance is unknown (no links and no layer: a fetched row whose sender sent none, an own row kept without them) is
 * `not_shared` too: it may name anything. Otherwise the row is served with its `layers` and `served` links cut to the shared networks.
 */
export function servableTo(row: ServableRow, shared: ReadonlySet<string>): Servable {
  if (row.origin === 'layer') {
    return row.networkId !== undefined && shared.has(row.networkId) ? { ok: true, links: row.links ? cutLinks(row.links, shared) : null } : { ok: false, code: 'not_shared' };
  }
  if (!row.links) return { ok: false, code: 'not_shared' };
  if (row.links.layers.some(l => !shared.has(l.networkId))) return { ok: false, code: 'not_shared' };
  return { ok: true, links: cutLinks(row.links, shared) };
}

function cutLinks(links: SnapshotLinks, shared: ReadonlySet<string>): SnapshotLinks {
  return { own: links.own, layers: cutTo(links.layers, shared), served: cutTo(links.served, shared) };
}

/** The keys a snapshot text of format 1 holds: an arriving text with any other is refused, a stored one names it unread. */
export const SNAPSHOT_TEXT_KEYS: ReadonlySet<string> = new Set(['format', 'typeSchemas', 'rules']);

/**
 * The envelope of a snapshot text: the parsed body when `text` is JSON, a plain object and `format: 1`, else `null`. Both readers of a text
 * open it here (`verifySnapshot`, strict, for an arriving text; `versionMetaOf`, tolerant, for a stored one), so the two never disagree on
 * what a version text is; each judges the body by its own rule.
 */
export function snapshotBodyOf(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  return isPlainObject(parsed) && parsed['format'] === 1 ? parsed : null;
}

/** Why a fetched text was refused: over the byte cap, not the text its fingerprint names, or not a canonical snapshot. */
export type SnapshotRefusal = 'over_cap' | 'refused_hash' | 'refused_shape';

/**
 * Is `text` the snapshot `fp` names? In this order: its UTF-8 bytes are at most the cap (never its length: a letter can be two bytes), its sha256 is
 * `fp`, it parses as JSON, it holds `format: 1` and the keys `format`, `typeSchemas` and `rules` only, the tolerant peer reader accepts the schema in it
 * (a bad property type is refused), and the canonical text of that schema is `text` itself (the same content pretty-printed or in another key order
 * is another text with another hash, and is refused).
 */
export function verifySnapshot(text: string, fp: string): { ok: true } | { ok: false; outcome: SnapshotRefusal } {
  if (isOverSnapshotCap(text)) return { ok: false, outcome: 'over_cap' };
  if (sha256Hex(text) !== fp) return { ok: false, outcome: 'refused_hash' };
  const refused = { ok: false, outcome: 'refused_shape' } as const;
  const body = snapshotBodyOf(text);
  if (!body) return refused;
  if (Object.keys(body).some(k => !SNAPSHOT_TEXT_KEYS.has(k))) return refused;
  const read = readPeerMeta({ typeSchemas: body['typeSchemas'] ?? {}, rules: body['rules'] ?? {} });
  if (!read.ok) return refused;
  return schemaFingerprintTextOf(read.meta) === text ? { ok: true } : refused;
}

/** The fingerprints in `carried` that `held` has no snapshot of, each once, in the order they were first carried. Never changes `held`. */
export function owedFingerprints(carried: Iterable<string>, held: ReadonlySet<string>): string[] {
  const owed = new Set<string>();
  for (const fp of carried) if (!held.has(fp)) owed.add(fp);
  return [...owed];
}

/** How a network the space shares with the sender gives this server its layer: from the sender above it, by a passed round, or not at all (the sender is below). */
export type LayerRole = 'upstream' | 'closed' | 'downstream';

/** What this server holds of one network it shares the space with the sender in: its layer's fingerprint, and every layer fingerprint it ever held a row of. */
export interface SharedNetwork {
  readonly networkId: string;
  readonly role: LayerRole;
  readonly layerFp: string;
  readonly heldLayerFps: readonly string[];
}

/** What a sender's snapshot answer says: its fingerprint, the links it sent and the network whose layer it is (a layer row has no links). */
export interface SenderSnapshot {
  readonly fp: string;
  readonly links: SnapshotLinks | null;
  readonly layerOf?: string;
}

/**
 * The networks on which this variation is behind the sender's, in the order of `mine.networks` (S-N3: a hint). On an `upstream` network the sender
 * is this server's upstream and what it SERVES for the network is what this server's layer should be (its own fingerprint when the snapshot is the
 * layer); on a `closed` network layers arrive by passed rounds and what it HOLDS is compared; a `downstream` sender is never ahead, because nobody takes
 * schema from below. Behind means the sender's fingerprint is a layer this server never held: a fingerprint is no order, so one it held before is the
 * SENDER being behind. A network the sender's links do not name is not judged.
 */
export function behindVerdict(mine: { readonly networks: readonly SharedNetwork[] }, sender: SenderSnapshot): string[] {
  const behind: string[] = [];
  for (const net of mine.networks) {
    if (net.role === 'downstream') continue;
    const theirs = sender.layerOf === net.networkId ? sender.fp
      : (net.role === 'upstream' ? sender.links?.served : sender.links?.layers)?.find(l => l.networkId === net.networkId)?.fp;
    if (theirs === undefined || theirs === net.layerFp || net.heldLayerFps.includes(theirs)) continue;
    behind.push(net.networkId);
  }
  return behind;
}

/**
 * How long a snapshot row stays after the sweep first found it unused (bundle-266, Q-739). Far longer than any write's read-to-land window
 * (`withinWriteBound` caps one at minutes): a write that read a version before a schema edit lands, stamped with it, long before its row may go, and
 * the removing pass reads the stored records again.
 */
export const SNAPSHOT_REMOVAL_GRACE_MS = 24 * 60 * 60_000;

/** The most rows one sweep pass removes from one space; the next pass takes the rest. */
export const SNAPSHOT_REMOVALS_PER_PASS = 256;

/** A snapshot row as the sweep reads it: never its text. `orphanSince` is the ISO time of the pass that first found it unused. */
export interface SweptRow {
  readonly _id: string;
  readonly origin: ServableRow['origin'];
  readonly links: SnapshotLinks | null;
  readonly orphanSince?: string;
}

/** What one sweep pass does to a space's rows, as fingerprints: rows to mark unused now, rows whose mark goes, rows to remove. */
export interface SnapshotSweepPlan {
  readonly mark: string[];
  readonly clear: string[];
  readonly remove: string[];
}

/**
 * Every fingerprint a row's links name (`links.own`, `links.layers[].fp`, `links.served[].fp`): THE reading of a row's links, for the sweep's keep
 * closure and the export's. Guarded as a stored row is read: absent or non-object links name none, a missing list is empty, and a value that is no
 * fingerprint is dropped. An own variation with no layer names its own fingerprint (`links.own`); a caller that must not count that drops it.
 */
export function snapshotLinksNamed(links: SnapshotLinks | null | undefined): string[] {
  if (!links || typeof links !== 'object') return [];
  return [links.own, ...(links.layers ?? []).map(l => l.fp), ...(links.served ?? []).map(l => l.fp)].filter(isSchemaFingerprint);
}

/** The other rows `row` links. Not itself: a self-link keeps nothing. */
const linkedBy = (row: SweptRow): string[] => snapshotLinksNamed(row.links).filter(fp => fp !== row._id);

/**
 * Which snapshot rows one sweep pass marks, clears and removes (design r2 D2 as r3 S-2 amends it). Pure: it changes nothing it is given.
 *
 * A row is a CANDIDATE when its origin is `own` or `fetched` (a `layer` row is the network history the behind hint reads, never removed), no stored
 * record carries it (`carried`), it is not the current variation's nor a held layer's (`keep`), and no row that stays this pass links it (by
 * `links.own`, `links.layers[].fp` or `links.served[].fp`), recomputed until nothing changes: a row is removed only when every row linking it goes too.
 * Then a candidate with no mark (or one that does not read as a time) is marked; a marked row that is no candidate loses its mark; and a candidate
 * marked at least `grace` before `now` is removed.
 *
 * What it prevents: a version a stored record names losing its text, and a version linked from one kept being removed under it. At most
 * {@link SNAPSHOT_REMOVALS_PER_PASS} rows are removed, whole linked groups only (a group cut in half would leave a staying row linking a removed one);
 * the bound counts removals, never marks.
 */
export function snapshotSweepPlan(rows: readonly SweptRow[], carried: ReadonlySet<string>, keep: ReadonlySet<string>, now: number, grace: number): SnapshotSweepPlan {
  const markedAt = (r: SweptRow): number => (r.orphanSince === undefined ? NaN : Date.parse(r.orphanSince));
  const unused = (r: SweptRow): boolean => r.origin !== 'layer' && !carried.has(r._id) && !keep.has(r._id);
  const removed = new Set(rows.filter(r => unused(r) && now - markedAt(r) >= grace).map(r => r._id));
  let linked = new Set<string>();
  for (let changed = true; changed;) {
    linked = new Set(rows.filter(r => !removed.has(r._id)).flatMap(linkedBy));
    changed = false;
    for (const id of removed) if (linked.has(id)) { removed.delete(id); changed = true; }
  }
  const candidate = (r: SweptRow): boolean => unused(r) && !linked.has(r._id);
  return {
    mark: rows.filter(r => candidate(r) && Number.isNaN(markedAt(r))).map(r => r._id),
    clear: rows.filter(r => r.orphanSince !== undefined && !candidate(r)).map(r => r._id),
    remove: boundedRemovals(rows.filter(r => removed.has(r._id))),
  };
}

/** The removals of one pass cut to the bound by whole linked groups (rows linking each other, either way), in the order the rows came. */
function boundedRemovals(removable: readonly SweptRow[]): string[] {
  if (removable.length <= SNAPSHOT_REMOVALS_PER_PASS) return removable.map(r => r._id);
  const ids = new Set(removable.map(r => r._id));
  const next = new Map<string, Set<string>>(removable.map(r => [r._id, new Set<string>()]));
  for (const r of removable) for (const to of linkedBy(r)) if (ids.has(to) && to !== r._id) { next.get(r._id)!.add(to); next.get(to)!.add(r._id); }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of removable) {
    if (seen.has(r._id)) continue;
    const group: string[] = [];
    for (const stack = [r._id]; stack.length > 0;) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id); group.push(id);
      stack.push(...next.get(id)!);
    }
    if (out.length + group.length <= SNAPSHOT_REMOVALS_PER_PASS) out.push(...group);
  }
  return out;
}
