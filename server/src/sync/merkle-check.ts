/**
 * Compare this instance's merkle root for a space with a peer's, after a sync with it — and say what was learnt.
 *
 * Moved out of `sync/engine.ts`, where it returned nothing: it logged `MERKLE_DIVERGENCE` and swallowed every failure as a
 * warning, so nothing could act on the answer. The re-read of a peer's file rows (`sync/file-meta-reread.ts`) is armed by a
 * divergence and cleared by a match, and needs the verdict to branch on.
 *
 * ## What it prevents
 *
 * **A check that learnt nothing being read as an answer.** A peer that 404s the route (it predates it), a body without a
 * root, a timeout, a store error computing our own root: each is `'unknown'`, never `'mismatch'` and never `'match'`. Read
 * as a mismatch it would arm a repair for a space where nobody disagrees; read as a match it would clear one that is owed.
 *
 * Non-fatal and never throws: the check does not block the sync or modify data.
 */
import { boundedJson } from '../util/bounded-read.js';
import { log, peerText } from '../util/log.js';
import { peerSafeFetch } from './peer-fetch.js';
import type { NetworkConfig, NetworkMember } from '../config/types.js';

/** What one check concluded: the roots are equal, they differ, or the check could not tell. */
export type MerkleComparison = 'match' | 'mismatch' | 'unknown';

export async function checkMerkleWithPeer(
  net: NetworkConfig,
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  opts: () => RequestInit,
): Promise<MerkleComparison> {
  try {
    const { computeMerkleRoot } = await import('../brain/merkle.js');
    const [localResult, peerResp] = await Promise.all([
      computeMerkleRoot(spaceId),
      peerSafeFetch(
        `${member.url}/api/sync/merkle?spaceId=${encodeURIComponent(remoteSpaceId)}&networkId=${encodeURIComponent(net.id)}`,
        opts(),
      ),
    ]);

    if (!peerResp.ok) {
      log.warn(`Merkle check for space '${peerText(spaceId)}' with peer '${peerText(member.label)}': peer returned HTTP ${peerResp.status} — skipping`);
      return 'unknown';
    }

    const peerResult = await boundedJson<{ root?: string; leafCount?: number }>(peerResp, 'sync peer');
    const peerRoot = peerResult.root;

    if (!peerRoot) {
      log.warn(`Merkle check for space '${peerText(spaceId)}' with peer '${peerText(member.label)}': peer response missing 'root' field`);
      return 'unknown';
    }

    if (localResult.root !== peerRoot) {
      log.warn(
        `MERKLE_DIVERGENCE: space '${peerText(spaceId)}', peer '${peerText(member.label)}' (${peerText(member.instanceId)}), ` +
        `network '${peerText(net.label)}'. ` +
        `local root=${peerText(localResult.root)} (${localResult.leafCount} leaves), ` +
        `peer root=${peerText(peerRoot)} (${peerResult.leafCount ?? '?'} leaves). ` +
        `The space contents differ after sync — possible data loss, concurrent write, or sync bug.`,
      );
      return 'mismatch';
    }
    log.info(`Merkle OK: space '${peerText(spaceId)}', peer '${peerText(member.label)}' root=${peerText(localResult.root.slice(0, 12))}…`);
    return 'match';
  } catch (err) {
    log.warn(`Merkle check for space '${peerText(spaceId)}' with peer '${peerText(member.label)}': ${peerText(err)}`);
    return 'unknown';
  }
}
