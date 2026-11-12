/**
 * The decisions of the schema snapshot fetch, as pure functions of their arguments (Q-738, bundle-265): which row a peer may be served, whether a fetched
 * text is the snapshot its fingerprint names, which fingerprints a space owes, and whether this variation is behind a sender's. No store, no peer and no
 * clock is read here, so each is tested with literals (`a-schema-snapshot-decisions-are-pure-functions`); the route (`api/sync/schema-snapshot.ts`) and the
 * receiver (`sync/schema-snapshot-fetch.ts`) call them and do the I/O.
 *
 * ## What each one prevents
 *
 * - {@link servableTo}: a snapshot that names another network's definitions reaching a member of this network only (F-39.2, "nothing mixed is sent
 *   on"). A variation built over a layer of N2 holds N2's definitions, which `GET /meta` never sends to N1; its snapshot must not either.
 * - {@link verifySnapshot}: a peer's text kept as a snapshot because it says so. It is kept only when it is the canonical text its fingerprint is the
 *   hash of, so what a fingerprint names is the same text on every instance.
 * - {@link owedFingerprints}: a fingerprint asked for twice, or asked for after a row holds it.
 * - {@link behindVerdict}: "my variation is behind" read from a sender's links as a HINT (S-N3): a peer's claim, so the caller logs and counts it and keeps
 *   nothing because of it.
 */
import { schemaFingerprintTextOf } from '@ythril-network/schema/internal';
import { readPeerMeta } from './body-schemas.js';
import { SCHEMA_SNAPSHOT_MAX_BYTES } from './schema-snapshot-store.js';
import type { SnapshotLinks } from './schema-stamp.js';
import { sha256Hex } from '../util/sha256-hex.js';

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

/** Why a fetched text was refused: over the byte cap, not the text its fingerprint names, or not a canonical snapshot. */
export type SnapshotRefusal = 'over_cap' | 'refused_hash' | 'refused_shape';

/**
 * Is `text` the snapshot `fp` names? In this order: its UTF-8 bytes are at most the cap (never its length: a letter can be two bytes), its sha256 is
 * `fp`, it parses as JSON, it holds `format: 1` and the keys `format`, `typeSchemas` and `rules` only, the tolerant peer reader accepts the schema in it
 * (a bad property type is refused), and the canonical text of that schema is `text` itself (the same content pretty-printed or in another key order
 * is another text with another hash, and is refused).
 */
export function verifySnapshot(text: string, fp: string): { ok: true } | { ok: false; outcome: SnapshotRefusal } {
  if (Buffer.byteLength(text, 'utf8') > SCHEMA_SNAPSHOT_MAX_BYTES) return { ok: false, outcome: 'over_cap' };
  if (sha256Hex(text) !== fp) return { ok: false, outcome: 'refused_hash' };
  const refused = { ok: false, outcome: 'refused_shape' } as const;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return refused; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return refused;
  const body = parsed as Record<string, unknown>;
  if (body['format'] !== 1) return refused;
  if (Object.keys(body).some(k => k !== 'format' && k !== 'typeSchemas' && k !== 'rules')) return refused;
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
