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
import { transferRefusal, turnSignal, type ExchangeTurn } from './held-answer.js';
import type { NetworkConfig, NetworkMember } from '../config/types.js';

/** What one check concluded: the roots are equal, they differ, or the check could not tell. */
export type MerkleComparison = 'match' | 'mismatch' | 'unknown';

/** What the divergence line says about one disagreement. */
export interface DivergenceFacts {
  spaceId: string; peerLabel: string; peerInstanceId: string; networkLabel: string;
  localRoot: string; localLeaves: number; peerRoot: string; peerLeaves: number | undefined;
}

/**
 * The `MERKLE_DIVERGENCE` line of one disagreement, naming the versions that await a decision when there are some (Q-624, design §9a, S8).
 *
 * A fork another instance resolved, behind a tombstone this instance's deletion rules declined, stays here until this instance's user decides it, and the
 * two roots differ by exactly that row. That is the cost of the owner's decision, so the line says so ("N unresolved versions here were resolved on another
 * instance and await a decision in Review") rather than leaving a divergence an operator reads as lost data. The count is read HERE, in the mismatch
 * branch only: a match asks nothing of the store. A count that cannot be read leaves the line as it was, because a failure to explain a divergence is not a
 * reason to say less about it.
 */
export async function divergenceLine(f: DivergenceFacts): Promise<string> {
  let awaiting = 0;
  try {
    const { forksAwaitingADecision } = await import('../brain/fork-counts.js');
    awaiting = await forksAwaitingADecision(f.spaceId);
  } catch { /* the line stands without the count */ }
  return `MERKLE_DIVERGENCE: space '${peerText(f.spaceId)}', peer '${peerText(f.peerLabel)}' (${peerText(f.peerInstanceId)}), ` +
    `network '${peerText(f.networkLabel)}'. ` +
    `local root=${peerText(f.localRoot)} (${f.localLeaves} leaves), ` +
    `peer root=${peerText(f.peerRoot)} (${f.peerLeaves ?? '?'} leaves). ` +
    `The space contents differ after sync — possible data loss, concurrent write, or sync bug.` +
    (awaiting > 0 ? ` ${awaiting} unresolved versions here were resolved on another instance and await a decision in Review, which accounts for part of the difference.` : '');
}

export async function checkMerkleWithPeer(
  net: NetworkConfig,
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  opts: () => RequestInit,
  turn?: ExchangeTurn,
): Promise<MerkleComparison> {
  try {
    const { computeMerkleRoot } = await import('../brain/merkle.js');
    const [localResult, peerResp] = await Promise.all([
      computeMerkleRoot(spaceId),
      peerSafeFetch(
        `${member.url}/api/sync/merkle?spaceId=${encodeURIComponent(remoteSpaceId)}&networkId=${encodeURIComponent(net.id)}`,
        { ...opts(), signal: turnSignal(opts().signal, turn) },
      ),
    ]);

    if (!peerResp.ok) {
      const verdict = await transferRefusal(peerResp);
      turn?.refusedBy(verdict);
      if (verdict !== 'failed') return 'unknown';
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
      log.warn(await divergenceLine({
        spaceId, peerLabel: member.label, peerInstanceId: member.instanceId, networkLabel: net.label,
        localRoot: localResult.root, localLeaves: localResult.leafCount, peerRoot, peerLeaves: peerResult.leafCount,
      }));
      return 'mismatch';
    }
    log.info(`Merkle OK: space '${peerText(spaceId)}', peer '${peerText(member.label)}' root=${peerText(localResult.root.slice(0, 12))}…`);
    return 'match';
  } catch (err) {
    log.warn(`Merkle check for space '${peerText(spaceId)}' with peer '${peerText(member.label)}': ${peerText(err)}`);
    return 'unknown';
  }
}
