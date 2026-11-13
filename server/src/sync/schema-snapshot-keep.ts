/**
 * Keep a schema snapshot text another instance sent, once it is verified (bundle-266, design r3 E-3): the one verify-then-keep path, shared by the
 * member's fetch (`sync/schema-snapshot-fetch.ts`) and the admin import.
 *
 * ## What it prevents
 *
 * A text kept as a snapshot because a sender says it is one. Each text is checked with `verifySnapshot` (the cap, the hash, the canonical shape) and
 * its links with {@link linksFrom} (the shape of links, or none) before one `ensureSnapshot`, bounded by `withinWriteBound`, lands it as `fetched`.
 * A second copy of this sequence in the import would be a second place to forget one of the checks.
 *
 * ## What it leaves to its caller
 *
 * It counts no metric and logs nothing: the fetch counts a refusal per member and version and the import counts its own outcomes, so each caller says
 * what it did in its own words. A failure of the write is thrown: the caller decides whether a store that is not answering ends its work.
 */
import { withinWriteBound } from '../db/write-bound.js';
import { ensureSnapshot } from '../spaces/schema-snapshot-store.js';
import { verifySnapshot, type SnapshotRefusal } from '../spaces/schema-snapshot.js';
import { isSchemaFingerprint, type SnapshotLinks } from '../spaces/schema-stamp.js';

/** The links a sender sent, if they are the shape of links: three fields, fingerprints, at most 64 entries per list. Anything else is no links. */
export function linksFrom(raw: unknown): SnapshotLinks | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const l = raw as Record<string, unknown>;
  const list = (v: unknown): SnapshotLinks['layers'] | undefined => {
    if (!Array.isArray(v) || v.length > 64) return undefined;
    const out: SnapshotLinks['layers'] = [];
    for (const e of v as Array<Record<string, unknown> | null>) {
      if (typeof e?.['networkId'] !== 'string' || e['networkId'].length === 0 || e['networkId'].length > 128 || !isSchemaFingerprint(e['fp'])) return undefined;
      out.push({ networkId: e['networkId'], fp: e['fp'] });
    }
    return out;
  };
  const layers = list(l['layers']);
  const served = list(l['served']);
  return isSchemaFingerprint(l['own']) && layers && served ? { own: l['own'], layers, served } : null;
}

/**
 * What became of a sent text: kept (`written`, or `held` when a row was known there), not kept now because an act stands on the space (`act_stands`;
 * nothing written), or refused (`over_cap`, `refused_hash`, `refused_shape`: it is not the snapshot `fp` names). A kept text answers the links kept.
 */
export type KeepVerifiedOutcome =
  | { outcome: 'written' | 'held' | 'act_stands'; links: SnapshotLinks | null }
  | { outcome: SnapshotRefusal };

/**
 * Verify `text` as the snapshot `fp` names and keep it in `spaceId` as `fetched` (from `from` when given), with `rawLinks` shape-checked. Throws what
 * the write throws.
 */
export async function keepVerifiedSnapshot(spaceId: string, fp: string, text: unknown, rawLinks: unknown, from?: string): Promise<KeepVerifiedOutcome> {
  if (typeof text !== 'string') return { outcome: 'refused_shape' };
  const verdict = verifySnapshot(text, fp);
  if (!verdict.ok) return { outcome: verdict.outcome };
  const links = linksFrom(rawLinks);
  // Bounded: neither the turn nor an import act is a request, so nothing else ends a write that waits on a locked document.
  const kept = await withinWriteBound(() => ensureSnapshot(spaceId, { fp, text }, { origin: 'fetched', ...(from !== undefined ? { from } : {}), links }));
  return { outcome: kept === 'refused' ? 'act_stands' : kept, links };
}
